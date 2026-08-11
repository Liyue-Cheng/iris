/**
 * @file src/main/session-manager.ts
 * @purpose PTY session pool — Marina's session layer ported with the anchor
 *   changed from path to document (technical-design.md 复用 Marina).
 *
 * Mechanisms carried over verbatim (all tuned & battle-tested in Marina):
 * - State machine: active(命令在产出) / idle(等输入) / exited(进程结束,
 *   scrollback 保留、无时限墓地、只能用户关闭)。Initial state is idle —
 *   "active" means THE USER'S COMMAND is running, not "bytes arrived".
 * - Three quiet windows that keep heuristics honest (bytes still flow to
 *   scrollback + renderer, they just don't mark the session active):
 *     startup grace 1500ms (shell banner), resize echo 500ms (ConPTY
 *     reflow; opened even for no-op resizes — remounts poke TUIs into
 *     full repaints), input echo 200ms (keystroke echo; Enter CLOSES the
 *     window so real command output lights up instantly).
 * - idle threshold 2s (configurable ≥100ms) from settings.
 * - PER-2: 8ms IPC aggregation; scrollbackLastSeq advances atomically with
 *   emit, pending bytes are invisible to the renderer (no double-write).
 * - CURSOR-1 state-replay: a headless xterm mirrors every session; remounts
 *   replay a SerializeAddon snapshot of the full terminal STATE (modes,
 *   alt-buffer, cursor) instead of raw byte rings — Claude Code/codex are
 *   alt-buffer TUIs, raw replay corrupts them.
 *
 * Cut from Marina: OSC 1337 cwd tracking & shell hooks (sessions anchor to
 * docs, cwd is always the project root), templates, SSH, LLM status
 * recheck (dumb shell), multi-window ownership (v1 single window).
 *
 * Iris-specific: session-context env injection — document sessions carry
 * FOCUS_DOC; workspace hubs carry IRIS_WORKSPACE_PATH. Dynamic context rides
 * process env (lives and dies with the session); static contracts ride the
 * prompt entry files. Two lifetimes, two pipes.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { spawn as defaultSpawnPty, type IPty, type IDisposable } from 'node-pty';
import type {
  AgentConfig,
  ProjectScope,
  SessionExitedPayload,
  SessionInfo,
  SessionOutputPayload,
  SessionReplaySnapshot,
  SessionStateChangedPayload,
} from '@shared/types';
import type { SettingsManager } from './settings-manager';
import { buildSpawnEnv, injectTerminalHintEnv, validateDimensions } from './pty-utils';
import { logger } from './logger';
import { mainT } from './i18n';
import { normalizedIdleThresholdMs, SessionActivityController } from './terminal/session-activity';
import { looksLikeShellStartupGarbage, sanitizeTerminalTitle } from './terminal/terminal-title';
// @xterm/headless is plain CommonJS (no ESM exports map) — default-import
// the module and destructure (Marina's lesson; named imports throw under
// the Electron main ESM loader).
import { TerminalOutputPump } from './terminal/output-pump';
import { TerminalMirror } from './terminal/terminal-mirror';
import { TerminalProtocol } from './terminal/terminal-protocol';
import { TerminalFlowController } from './terminal/flow-controller';
import { TerminalFlightRecorder } from './terminal/flight-recorder';
import { terminalBaseColors } from '@shared/terminal/terminal-colors';
import { reduceTerminalProcess } from '@shared/terminal/process-reducer';
import { ReplayCoordinator } from './terminal/replay-coordinator';
import type { SessionRecord } from './terminal/session-record';
import {
  defaultProcessTreeKiller,
  type ProcessTreeKillFn,
} from './terminal/process-tree';

const SPAWN_ENV_SKIP = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL'];

/** Anti-flicker parameters — verified in Marina, copied as-is. */
const RESIZE_QUIET_MS = 500;
const STARTUP_GRACE_MS = 1500;
const INPUT_QUIET_MS = 200;
/** sessionOutput IPC aggregation window (125fps — invisible, but burst
 *  output drops from hundreds of IPC/s to ~30-60). */
const EMIT_BATCH_MS = 8;
const OUTPUT_HIGH_WATER_BYTES = 384 * 1024;
const OUTPUT_LOW_WATER_BYTES = 96 * 1024;
/** Renderer xterm scrollback is 5000 — headless mirror must match so the
 *  serialized replay covers everything the user can scroll to. */
const SCROLLBACK_LINES = 5000;
/** Hard cap on the replay parser-drain fence (see prepareReplayNow).
 *  The fence almost always resolves in <1ms; this only fires if xterm drops
 *  the fence callback, so we serialize a tick-stale mirror instead of hanging
 *  the IPC reply until the renderer's 5s failsafe (持久-2026-06-25). */
const REPLAY_FENCE_CAP_MS = 250;
/** Alt-buffer replay waits for the TUI's resize redraw to go quiet before
 *  serializing. The cap covers both the nudge and final target resize. */
const REPLAY_REDRAW_QUIET_MS = 50;
const REPLAY_REDRAW_CAP_MS = 500;
const REPLAY_NUDGE_QUIET_MS = 20;
const REPLAY_NUDGE_CAP_MS = 150;
/** After the process-tree terminator returns, allow node-pty's exit event a
 * short bounded window to close its native handles before forgetting the PTY. */
const PTY_EXIT_WAIT_MS = 2000;

interface OutputQuietResult {
  sawOutput: boolean;
  capped: boolean;
  elapsedMs: number;
}

interface OutputQuietWaiter {
  promise: Promise<OutputQuietResult>;
  cancel: () => void;
}

export type PtySpawnFn = (
  file: string,
  args: string[] | string,
  options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
    useConpty?: boolean;
    /** Use node-pty's bundled ConPTY DLL on Windows. */
    useConptyDll?: boolean;
  },
) => IPty;

export class SessionManagerError extends Error {
  constructor(
    public readonly code:
      | 'SessionNotFound'
      | 'AgentNotFound'
      | 'CwdNotAccessible'
      | 'PtySpawnFailed'
      | 'NoShellAvailable',
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(`[SessionManager] ${code}: ${message}`);
    this.name = 'SessionManagerError';
  }
}

export interface CreateSessionInput {
  /** Doc rel path (forward slashes) or null for a workspace-hub session. */
  docPath: string | null;
  /** Hub workspace when docPath is null (`.iris` = root). Injected as
   *  IRIS_WORKSPACE_PATH, never as FOCUS_DOC. Ignored when docPath is set. */
  workspacePath?: string | null;
  agentId: string;
  projectRoot: string;
  projectGeneration: number;
  cols: number;
  rows: number;
}

export interface CreateCommandSessionInput
  extends Omit<CreateSessionInput, 'agentId' | 'docPath' | 'workspacePath'> {
  actionIndex: number;
  description: string;
  command: string;
}

/**
 * Locate the shell that hosts agent commands. Windows: pwsh → powershell →
 * cmd, probed on PATH via the spawn env. POSIX: $SHELL → /bin/bash.
 */
export function resolveHostShell(env: Record<string, string>): {
  file: string;
  /** Agent commands always return to an interactive shell when they exit. */
  buildArgs: (command: string) => string[];
} {
  if (process.platform === 'win32') {
    // PATH probing via where.exe is slow; node-pty resolves bare names
    // against env.PATH itself, so just pick the first known-present name.
    const candidates = ['pwsh.exe', 'powershell.exe'];
    const pathDirs = (env.PATH ?? env.Path ?? '').split(';');
    for (const c of candidates) {
      for (const d of pathDirs) {
        if (d && existsSync(`${d.replace(/[\\/]+$/, '')}\\${c}`)) {
          return {
            file: c,
            buildArgs: (command) =>
              command
                ? ['-NoLogo', '-NoExit', '-Command', command]
                : ['-NoLogo'],
          };
        }
      }
    }
    return {
      file: 'cmd.exe',
      buildArgs: (command) => (command ? ['/k', command] : []),
    };
  }
  const shell = process.env.SHELL || '/bin/bash';
  return {
    file: shell,
    // After the command, re-exec an interactive login shell so the prompt
    // returns instead of the PTY dying.
    buildArgs: (command) =>
      command
        ? ['-lc', `${command}; exec "${shell}" -il`]
        : ['-l'],
  };
}

export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly replayCoordinator = new ReplayCoordinator();
  private readonly spawnFn: PtySpawnFn;
  private readonly processTreeKillFn: ProcessTreeKillFn | null;
  private readonly ptyExitWaitMs: number;
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    private readonly settingsManager: SettingsManager,
    options?: {
      spawnFn?: PtySpawnFn;
      processTreeKillFn?: ProcessTreeKillFn | null;
      ptyExitWaitMs?: number;
    },
  ) {
    super();
    this.spawnFn = options?.spawnFn ?? (defaultSpawnPty as PtySpawnFn);
    this.processTreeKillFn =
      options?.processTreeKillFn === undefined
        ? defaultProcessTreeKiller()
        : options.processTreeKillFn;
    this.ptyExitWaitMs = options?.ptyExitWaitMs ?? PTY_EXIT_WAIT_MS;
  }

  createSession(input: CreateSessionInput): SessionInfo {
    const settings = this.settingsManager.get();
    const agent: AgentConfig | undefined = settings.agents.find((a) => a.id === input.agentId);
    if (!agent) {
      throw new SessionManagerError(
        'AgentNotFound',
        mainT('error.agentNotFound', { agentId: input.agentId }),
      );
    }
    return this.createConfiguredSession(input, agent);
  }

  /** Start one project toolbar command as a fresh project-root hub PTY. */
  createCommandSession(input: CreateCommandSessionInput): SessionInfo {
    const launcher: AgentConfig = {
      id: `project-action:${input.actionIndex}`,
      label: input.description,
      command: input.command,
    };
    return this.createConfiguredSession(
      {
        docPath: null,
        workspacePath: '.iris',
        agentId: launcher.id,
        projectRoot: input.projectRoot,
        projectGeneration: input.projectGeneration,
        cols: input.cols,
        rows: input.rows,
      },
      launcher,
    );
  }

  private createConfiguredSession(input: CreateSessionInput, agent: AgentConfig): SessionInfo {
    const dims = validateDimensions(input.cols, input.rows);
    const cwd = input.projectRoot;
    try {
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
        throw new SessionManagerError(
          'CwdNotAccessible',
          mainT('error.projectRootInvalid', { cwd }),
          { cwd },
        );
      }
    } catch (err) {
      if (err instanceof SessionManagerError) throw err;
      throw new SessionManagerError(
        'CwdNotAccessible',
        mainT('error.projectRootReadFailed', { cwd }),
        { cwd },
      );
    }

    const env = buildSpawnEnv(process.env, SPAWN_ENV_SKIP);
    injectTerminalHintEnv(env, { programName: 'Iris' });
    // Document focus and hub scope are mutually exclusive. Clear the other
    // variable explicitly so a child cannot inherit stale Iris context from
    // the Electron process. Bare launch: opening is not running.
    if (input.docPath) {
      env.FOCUS_DOC = input.docPath;
      delete env.IRIS_WORKSPACE_PATH;
    } else {
      delete env.FOCUS_DOC;
      env.IRIS_WORKSPACE_PATH = input.workspacePath ?? '.iris';
    }

    const host = resolveHostShell(env);
    const args = host.buildArgs(agent.command);

    let pty: IPty;
    try {
      pty = this.spawnFn(host.file, args, {
        name: 'xterm-256color',
        cols: dims.cols,
        rows: dims.rows,
        cwd,
        env,
        // Explicit ConPTY: avoids winpty fallback flashing a conhost window.
        useConpty: true,
        // The bundled DLL preserves synchronized-output boundaries that the
        // system ConPTY can split into separate data packets, which exposes a
        // transient cursor position in xterm during Codex frame rendering.
        // node-pty ignores this option on non-Windows platforms.
        useConptyDll: process.platform === 'win32',
      });
    } catch (err) {
      throw new SessionManagerError(
        'PtySpawnFailed',
        mainT('error.ptySpawnFailed', {
          shellPath: host.file,
          agentId: agent.id,
          cwd,
          error: err instanceof Error ? err.message : String(err),
        }),
        { shellPath: host.file, cwd },
      );
    }

    const sessionId = randomUUID();
    const info: SessionInfo = {
      id: sessionId,
      docPath: input.docPath,
      // Doc sessions carry no hub grouping; hub sessions default to the root
      // workspace when none is given (back-compat with plain root spawns).
      workspacePath: input.docPath ? null : (input.workspacePath ?? '.iris'),
      agentId: agent.id,
      displayName: agent.label,
      terminalTitle: null,
      projectRoot: cwd,
      projectGeneration: input.projectGeneration,
      cols: dims.cols,
      rows: dims.rows,
      pid: pty.pid,
      // BETA-008 semantics: idle until a real (non-quiet-window) byte
      // arrives — a freshly opened session is "waiting", not "working".
      state: 'idle',
      createdAt: Date.now(),
    };

    let managed: SessionRecord;
    const recorder = new TerminalFlightRecorder();
    recorder.record('created', { pid: info.pid, cols: info.cols, rows: info.rows });
    const activity = new SessionActivityController(
      info.createdAt,
      () =>
        normalizedIdleThresholdMs(
          this.settingsManager.get().advanced.activeIdleThresholdSeconds,
        ),
      (state) => {
        if (managed.processState !== 'running') return;
        recorder.record('activity', { state });
        managed.info.state = state;
        this.emitStateChanged(managed, { state });
      },
      {
        startupGraceMs: STARTUP_GRACE_MS,
        resizeQuietMs: RESIZE_QUIET_MS,
        inputQuietMs: INPUT_QUIET_MS,
      },
    );
    const flow = new TerminalFlowController(
      () => {
        try {
          pty.pause();
          recorder.record('flow-paused');
        } catch (err) {
          logger.warn('session', `pty pause failed sid=${sessionId}`, err);
        }
      },
      () => {
        try {
          pty.resume();
          recorder.record('flow-resumed');
        } catch (err) {
          logger.warn('session', `pty resume failed sid=${sessionId}`, err);
        }
      },
    );
    const flowLimits = {
      highBytes: OUTPUT_HIGH_WATER_BYTES,
      lowBytes: OUTPUT_LOW_WATER_BYTES,
    };
    managed = {
      info,
      pty,
      disposables: [],
      output: new TerminalOutputPump(
        sessionId,
        () => ({ root: info.projectRoot, generation: info.projectGeneration }),
        (payload) => this.emit('sessionOutput', payload),
        EMIT_BATCH_MS,
        { ...flowLimits, setBlocked: (blocked) => flow.setBlocked('renderer', blocked) },
        false,
      ),
      activity,
      mirror: new TerminalMirror(info.cols, info.rows, SCROLLBACK_LINES, {
        ...flowLimits,
        setBlocked: (blocked) => flow.setBlocked('mirror', blocked),
      }),
      protocol: new TerminalProtocol(() =>
        terminalBaseColors(this.settingsManager.get().appearance.theme),
      ),
      flow,
      outputAttachmentId: null,
      recorder,
      processState: 'running',
      closePromise: null,
    };
    this.sessions.set(sessionId, managed);

    managed.disposables.push(
      pty.onData((data) => this.handlePtyData(managed, data)),
      pty.onExit(({ exitCode, signal }) => this.handlePtyExit(managed, exitCode, signal)),
      // Live terminal title (OSC 0/2): the headless mirror parses every byte,
      // so its onTitleChange fires for each title sequence. The renderer's
      // xterm only exists for the shown session — tracking it here keeps every
      // session's title live and surviving switches (Marina TIT-1).
      managed.mirror.onTitleChange((title) => this.handleTitle(managed, title)),
    );

    this.emit('sessionCreated', { ...info });
    return { ...info };
  }

  /** Close & destroy (user gesture or app quit) — the only removal path. */
  closeSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId);
    if (!managed) return Promise.resolve();
    return this.destroySession(managed, 'user-closed');
  }

  /**
   * Re-anchor a live session to another doc (or the project root with null).
   * Marina's anchoring model: the path edits the doc — the PTY itself is
   * untouched, so the process keeps its original FOCUS_DOC env; the protocol
   * explicitly tolerates that ("没被读，人补一句话就行"). Used by the
   * delete-file gesture to keep orphaned terminals alive under the root.
   */
  reanchor(sessionId: string, docPath: string | null): SessionInfo {
    const managed = this.sessions.get(sessionId);
    if (!managed) throw new Error(`[session:reanchor] unknown session ${sessionId}`);
    managed.info.docPath = docPath;
    this.emitStateChanged(managed, { docPath });
    return { ...managed.info };
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = Promise.all(
      [...this.sessions.values()].map((managed) => this.destroySession(managed, 'app-quit')),
    ).then(() => undefined);
    return this.shutdownPromise;
  }

  /** Drain one committed project without retiring this per-window manager. */
  async closeProject(scope: ProjectScope): Promise<void> {
    const matching = [...this.sessions.values()].filter(
      (managed) =>
        managed.info.projectRoot === scope.root &&
        managed.info.projectGeneration === scope.generation,
    );
    const results = await Promise.allSettled(
      matching.map((managed) => this.destroySession(managed, 'project-switched')),
    );
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        logger.warn(
          'session',
          `project drain failed sid=${matching[index]?.info.id ?? 'unknown'}`,
          result.reason,
        );
      }
    });
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((m) => ({ ...m.info }));
  }

  get(sessionId: string): SessionInfo | null {
    const m = this.sessions.get(sessionId);
    return m ? { ...m.info } : null;
  }

  /**
   * Write input. Enter closes the input-quiet window (real output right
   * after a submit must light up instantly); other keys extend it.
   */
  sendInput(
    sessionId: string,
    base64Data: string,
  ): { accepted: boolean; reason?: 'session-not-found' | 'pty-exited' | 'pty-write-failed' } {
    const managed = this.sessions.get(sessionId);
    if (!managed) return { accepted: false, reason: 'session-not-found' };
    if (!managed.pty || managed.processState !== 'running') {
      return { accepted: false, reason: 'pty-exited' };
    }
    const text = Buffer.from(base64Data, 'base64').toString('utf8');
    managed.activity.noteInput(text);
    try {
      managed.pty.write(text);
    } catch (err) {
      // ConPTY half-closed race: surface instead of silently failing keys.
      logger.warn('session', `pty.write failed sid=${sessionId}`, err);
      return { accepted: false, reason: 'pty-write-failed' };
    }
    return { accepted: true };
  }

  /** Resize from a real renderer layout change. */
  resize(
    sessionId: string,
    cols: number,
    rows: number,
  ): { accepted: boolean; reason?: 'session-not-found' | 'pty-exited' | 'invalid-dimensions' } {
    const managed = this.sessions.get(sessionId);
    if (!managed) return { accepted: false, reason: 'session-not-found' };
    if (!managed.pty || managed.processState !== 'running') {
      return { accepted: false, reason: 'pty-exited' };
    }
    const dims = validateDimensions(cols, rows);
    managed.activity.noteResize();
    if (dims.cols === managed.info.cols && dims.rows === managed.info.rows) {
      return { accepted: true };
    }
    try {
      this.applyDimensions(managed, dims.cols, dims.rows, true);
    } catch (err) {
      logger.warn('session', `resize ignored sid=${sessionId} ${dims.cols}x${dims.rows}`, err);
      return { accepted: false, reason: 'invalid-dimensions' };
    }
    return { accepted: true };
  }

  /**
   * Full-state replay for remounts (CURSOR-1 architecture): serialize the
   * headless mirror — a state rebuild, not a byte-ring replay, so DEC modes
   * and alt-buffer survive no matter how much output has scrolled by.
   *
   * Ordering: flush pending emit → freeze replayLastSeq → drain the headless
   * parser (a zero-length write is xterm's official fence) → serialize. Bytes
   * arriving after the boundary go through the normal 8ms batch and the
   * renderer filters seq > replayLastSeq — no loss, no double-write.
   *
   * The fence MUST be a Uint8Array(0), not write('', cb): an empty string is
   * falsy, so if a headless resize() lands while the fence sits in the write
   * queue, WriteBuffer.flushSync()'s `while (chunk = shift())` loop treats ''
   * as the end-of-queue sentinel — it drops the chunk AND its callback without
   * calling it. The fence promise then never resolves and this IPC reply hangs
   * until the renderer's 5s failsafe: the "切终端卡几秒" heisenbug
   * (持久-2026-06-25). A Uint8Array(0) is a truthy object that flushSync
   * processes (and calls back) normally; REPLAY_FENCE_CAP_MS is the belt to
   * its suspenders.
   */
  async prepareReplay(
    sessionId: string,
    cols: number,
    rows: number,
  ): Promise<SessionReplaySnapshot> {
    return this.replayCoordinator.run(sessionId, async () => {
      const record = this.sessions.get(sessionId);
      record?.recorder.record('replay-started', { cols, rows });
      try {
        const replay = await this.prepareReplayNow(sessionId, cols, rows);
        record?.recorder.record('replay-completed', {
          lastSeq: replay.lastSeq,
          bytes: Buffer.byteLength(replay.data, 'base64'),
        });
        return replay;
      } catch (error) {
        record?.recorder.record('replay-failed');
        throw error;
      }
    });
  }

  private async prepareReplayNow(
    sessionId: string,
    cols: number,
    rows: number,
  ): Promise<SessionReplaySnapshot> {
    const managed = this.sessions.get(sessionId);
    if (!managed) {
      const dims = validateDimensions(cols, rows);
      return { data: '', lastSeq: -1, ...dims };
    }
    const mirror = managed.mirror;
    const dims = validateDimensions(cols, rows);

    managed.activity.noteResize();
    const altBufferActive = mirror.activeBufferType === 'alternate';
    if (managed.pty && altBufferActive) {
      const redrawDeadline = Date.now() + REPLAY_REDRAW_CAP_MS;
      managed.activity.suppressResizeOutputUntil(redrawDeadline + RESIZE_QUIET_MS);
      const unchanged = dims.cols === managed.info.cols && dims.rows === managed.info.rows;

      if (unchanged) {
        // ConPTY ignores a same-size resize. Give the TUI enough time to see a
        // one-row nudge before restoring the requested size; doing both calls
        // synchronously lets ConPTY coalesce them into no notification at all.
        const nudgeRows = dims.rows > 5 ? dims.rows - 1 : dims.rows + 1;
        await this.resizeAndWaitForOutput(
          managed,
          dims.cols,
          nudgeRows,
          false,
          REPLAY_NUDGE_QUIET_MS,
          Math.min(REPLAY_NUDGE_CAP_MS, Math.max(1, redrawDeadline - Date.now())),
        );
      }

      const targetResult = await this.resizeAndWaitForOutput(
        managed,
        dims.cols,
        dims.rows,
        true,
        REPLAY_REDRAW_QUIET_MS,
        Math.max(1, redrawDeadline - Date.now()),
      );
      if (targetResult.capped) {
        logger.warn(
          'session',
          `replay redraw capped sid=${sessionId} ${dims.cols}x${dims.rows} ` +
            `output=${targetResult.sawOutput} elapsed=${targetResult.elapsedMs}ms`,
        );
      }
    } else {
      // Normal buffers can be reflowed authoritatively by xterm itself. Exited
      // sessions also have no process left to redraw, so only resize the mirror.
      this.applyDimensions(managed, dims.cols, dims.rows, true);
    }

    managed.output.flush();
    // Freeze the replay boundary before inserting the parser fence. Any PTY
    // bytes that arrive after this point are written behind the fence, so the
    // snapshot below cannot contain them even if their IPC batch is emitted
    // while we are waiting for the fence/serialize work.
    const replayLastSeq = managed.output.replayBoundarySeq;
    await mirror.fence(REPLAY_FENCE_CAP_MS, () => {
      logger.warn('session', `replay fence capped sid=${sessionId} (callback dropped?)`);
    });

    const ansi = mirror.serialize(SCROLLBACK_LINES);
    const data = Buffer.from(ansi, 'utf8').toString('base64');

    return {
      data,
      lastSeq: replayLastSeq,
      cols: dims.cols,
      rows: dims.rows,
    };
  }

  private applyDimensions(
    managed: SessionRecord,
    cols: number,
    rows: number,
    updateInfo: boolean,
  ): void {
    managed.pty?.resize(cols, rows);
    try {
      managed.mirror.resize(cols, rows);
    } catch {
      /* headless resize must never block the real one */
    }
    if (updateInfo) {
      managed.info.cols = cols;
      managed.info.rows = rows;
    }
  }

  private async resizeAndWaitForOutput(
    managed: SessionRecord,
    cols: number,
    rows: number,
    updateInfo: boolean,
    quietMs: number,
    capMs: number,
  ): Promise<OutputQuietResult> {
    if (!managed.pty) {
      this.applyDimensions(managed, cols, rows, updateInfo);
      return { sawOutput: false, capped: false, elapsedMs: 0 };
    }

    const waiter = this.createOutputQuietWaiter(
      managed.info.id,
      managed.output.nextSeq,
      quietMs,
      capMs,
    );
    try {
      this.applyDimensions(managed, cols, rows, updateInfo);
    } catch (err) {
      waiter.cancel();
      throw err;
    }
    return waiter.promise;
  }

  private createOutputQuietWaiter(
    sessionId: string,
    minSeq: number,
    quietMs: number,
    capMs: number,
  ): OutputQuietWaiter {
    const startedAt = Date.now();
    let settle: (capped: boolean) => void = () => undefined;
    const promise = new Promise<OutputQuietResult>((resolve) => {
      let settled = false;
      let sawOutput = false;
      let quietTimer: ReturnType<typeof setTimeout> | null = null;
      let capTimer: ReturnType<typeof setTimeout> | null = null;
      const onOutput = (payload: SessionOutputPayload): void => {
        if (payload.sessionId !== sessionId || payload.seq < minSeq) return;
        sawOutput = true;
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(() => settle(false), quietMs);
      };

      settle = (capped: boolean): void => {
        if (settled) return;
        settled = true;
        if (quietTimer) clearTimeout(quietTimer);
        if (capTimer) clearTimeout(capTimer);
        this.off('sessionOutput', onOutput);
        resolve({ sawOutput, capped, elapsedMs: Date.now() - startedAt });
      };

      this.on('sessionOutput', onOutput);
      capTimer = setTimeout(() => settle(true), Math.max(1, capMs));
    });

    return { promise, cancel: () => settle(true) };
  }

  // ──────────────────────────────────────────────────────────────────
  // Internal: PTY data → batch → state machine
  // ──────────────────────────────────────────────────────────────────

  private handlePtyData(managed: SessionRecord, data: string): void {
    // ConPTY can emit one final onData after teardown started.
    if (
      !this.sessions.has(managed.info.id) ||
      !managed.pty ||
      managed.processState !== 'running'
    ) {
      return;
    }
    const protocol = managed.protocol.consume(data);
    if (protocol.replies.length > 0) {
      managed.recorder.record('protocol-reply', { count: protocol.replies.length });
    }
    for (const reply of protocol.replies) {
      try {
        managed.pty.write(reply);
      } catch (err) {
        logger.warn('session', `terminal protocol reply failed sid=${managed.info.id}`, err);
      }
    }
    const bytes = Buffer.from(protocol.display, 'utf8');
    if (bytes.length === 0) {
      managed.activity.noteOutput();
      return;
    }

    managed.output.enqueue(bytes);

    // Feed the headless mirror (async parse; replay paths drain first).
    managed.mirror.write(protocol.display);

    // State machine: bytes mean active — unless a quiet window says these
    // bytes are echo/banner/reflow, in which case the state stays put
    // (scrollback and renderer output are unaffected either way).
    managed.activity.noteOutput();
  }

  private flushPendingEmitBeforeLifecycleChange(managed: SessionRecord): void {
    managed.output.flush();
  }

  private handlePtyExit(managed: SessionRecord, exitCode: number, signal: number | undefined): void {
    if (!this.sessions.has(managed.info.id)) return;
    if (managed.processState === 'exited' || managed.processState === 'disposed') return;

    // Causal order for the renderer: last output → exited, never reversed.
    this.flushProtocolPending(managed);
    this.flushPendingEmitBeforeLifecycleChange(managed);

    const payload: SessionExitedPayload = {
      scope: this.scopeOf(managed),
      sessionId: managed.info.id,
      exitCode,
      ...(typeof signal === 'number' ? { signal } : {}),
    };
    this.emit('sessionExited', payload);

    managed.info.state = 'exited';
    managed.processState = reduceTerminalProcess(managed.processState, { type: 'EXITED' });
    managed.info.exitCode = exitCode;
    managed.info.exitedAt = Date.now();
    managed.recorder.record('exited', { exitCode, signal: signal ?? null });
    managed.activity.dispose();
    managed.pty = null;

    this.emitStateChanged(managed, {
      state: 'exited',
      exitCode,
      exitedAt: managed.info.exitedAt,
      pid: -1,
    });
  }

  private destroySession(
    managed: SessionRecord,
    reason: 'user-closed' | 'project-switched' | 'app-quit',
  ): Promise<void> {
    const sid = managed.info.id;
    if (!this.sessions.has(sid)) return Promise.resolve();
    if (managed.closePromise) return managed.closePromise;

    managed.processState = reduceTerminalProcess(managed.processState, { type: 'CLOSE' });
    managed.recorder.record('closing');
    managed.closePromise = this.destroySessionNow(managed, reason);
    return managed.closePromise;
  }

  attachOutput(sessionId: string, attachmentId: string): boolean {
    const target = this.sessions.get(sessionId);
    if (!target) return false;
    for (const record of this.sessions.values()) {
      if (record === target) continue;
      record.outputAttachmentId = null;
      record.output.setDeliveryEnabled(false);
    }
    target.outputAttachmentId = attachmentId;
    target.output.setDeliveryEnabled(true);
    target.recorder.record('renderer-attached', { attachmentId });
    return true;
  }

  detachOutput(attachmentId: string): void {
    for (const record of this.sessions.values()) {
      if (record.outputAttachmentId !== attachmentId) continue;
      record.outputAttachmentId = null;
      record.output.setDeliveryEnabled(false);
      record.recorder.record('renderer-detached', { attachmentId });
      return;
    }
  }

  acknowledgeOutput(sessionId: string, attachmentId: string, seq: number): void {
    const record = this.sessions.get(sessionId);
    if (!record || record.outputAttachmentId !== attachmentId) return;
    record.output.acknowledge(seq);
  }

  diagnostics(): Array<{
    sessionId: string;
    state: SessionInfo['state'];
    processState: SessionRecord['processState'];
    output: TerminalOutputPump['diagnostics'];
    mirror: TerminalMirror['diagnostics'];
    flow: TerminalFlowController['snapshot'];
    events: ReturnType<TerminalFlightRecorder['snapshot']>;
  }> {
    return [...this.sessions.values()].map((record) => ({
      sessionId: record.info.id,
      state: record.info.state,
      processState: record.processState,
      output: record.output.diagnostics,
      mirror: record.mirror.diagnostics,
      flow: record.flow.snapshot,
      events: record.recorder.snapshot(),
    }));
  }

  private async destroySessionNow(
    managed: SessionRecord,
    reason: 'user-closed' | 'project-switched' | 'app-quit',
  ): Promise<void> {
    const sid = managed.info.id;

    this.flushProtocolPending(managed);
    this.flushPendingEmitBeforeLifecycleChange(managed);
    managed.activity.dispose();

    const pty = managed.pty;
    if (pty) {
      const exited = this.waitForPtyExit(pty);
      if (this.processTreeKillFn) {
        try {
          // Run while the root shell PID still exists. Once node-pty closes the
          // pseudoconsole, detached descendants can outlive that PID and can no
          // longer be reached reliably through taskkill's /T traversal.
          await this.processTreeKillFn(managed.info.pid);
        } catch (err) {
          logger.warn('session', `process-tree kill failed sid=${sid} pid=${managed.info.pid}`, err);
        }
      }
      try {
        // taskkill terminates processes; node-pty.kill still must close the
        // pseudoconsole, pipes and native worker owned by this Electron process.
        pty.kill();
      } catch (err) {
        logger.warn('session', `kill failed sid=${sid}`, err);
      }
      if (!(await exited.promise)) {
        logger.warn('session', `pty exit timed out sid=${sid} pid=${managed.info.pid}`);
      }
      exited.dispose();
    }

    for (const d of managed.disposables) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    managed.disposables = [];
    managed.pty = null;
    managed.output.dispose({ flush: false });
    try {
      managed.mirror.dispose();
    } catch {
      /* ignore */
    }
    managed.processState = reduceTerminalProcess(managed.processState, { type: 'DISPOSE' });
    managed.recorder.record('disposed');
    this.sessions.delete(sid);
    this.emit('sessionDestroyed', { scope: this.scopeOf(managed), sessionId: sid, reason });
  }

  private waitForPtyExit(pty: IPty): { promise: Promise<boolean>; dispose: () => void } {
    let disposable: IDisposable | null = null;
    let timer: NodeJS.Timeout | null = null;
    let settled = false;
    let resolvePromise: (exited: boolean) => void = () => {};
    const promise = new Promise<boolean>((resolve) => {
      resolvePromise = resolve;
    });
    const settle = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      resolvePromise(exited);
    };
    disposable = pty.onExit(() => settle(true));
    timer = setTimeout(() => settle(false), this.ptyExitWaitMs);
    return {
      promise,
      dispose: () => {
        if (timer) clearTimeout(timer);
        timer = null;
        disposable?.dispose();
        disposable = null;
      },
    };
  }

  private flushProtocolPending(managed: SessionRecord): void {
    const trailing = managed.protocol.reset();
    if (!trailing) return;
    managed.output.enqueue(Buffer.from(trailing, 'utf8'));
    managed.mirror.write(trailing);
  }

  /**
   * OSC 0/2 title event → update info.terminalTitle and broadcast.
   *
   * Sanitize (strip control / bidi chars, collapse spaces, cap length), then
   * drop "startup garbage" titles — ConPTY translates a shell's initial
   * SetConsoleTitle(exe path) into an OSC 0, and Git Bash re-sends its
   * `MINGW64:<cwd>` PS1 prefix every prompt; neither is a useful title. Real
   * CLI titles (vim …, ✻ Claude …) are verb-leading and pass the guard
   * (Marina TIT-1). De-dupe so an unchanged title never broadcasts.
   */
  private handleTitle(managed: SessionRecord, rawTitle: string): void {
    if (managed.processState !== 'running') return;
    const cleaned = sanitizeTerminalTitle(rawTitle);
    if (!cleaned) return;
    if (looksLikeShellStartupGarbage(cleaned)) return;
    if (cleaned === managed.info.terminalTitle) return;
    managed.info.terminalTitle = cleaned;
    this.emitStateChanged(managed, { terminalTitle: cleaned });
  }

  private emitStateChanged(managed: SessionRecord, patch: Partial<SessionInfo>): void {
    const payload: SessionStateChangedPayload = {
      scope: this.scopeOf(managed),
      sessionId: managed.info.id,
      patch,
    };
    this.emit('sessionStateChanged', payload);
  }

  private scopeOf(managed: SessionRecord): ProjectScope {
    return {
      root: managed.info.projectRoot,
      generation: managed.info.projectGeneration,
    };
  }
}

export { looksLikeShellStartupGarbage } from './terminal/terminal-title';
