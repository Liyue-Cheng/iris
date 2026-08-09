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
import { execFile } from 'node:child_process';
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
// @xterm/headless is plain CommonJS (no ESM exports map) — default-import
// the module and destructure (Marina's lesson; named imports throw under
// the Electron main ESM loader).
import xtermHeadless from '@xterm/headless';
const { Terminal: HeadlessTerminal } = xtermHeadless;
type HeadlessTerminal = InstanceType<typeof HeadlessTerminal>;
import xtermSerialize from '@xterm/addon-serialize';
const { SerializeAddon } = xtermSerialize;
type SerializeAddon = InstanceType<typeof SerializeAddon>;

const SPAWN_ENV_SKIP = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL'];

/** Anti-flicker parameters — verified in Marina, copied as-is. */
const RESIZE_QUIET_MS = 500;
const STARTUP_GRACE_MS = 1500;
const INPUT_QUIET_MS = 200;
/** sessionOutput IPC aggregation window (125fps — invisible, but burst
 *  output drops from hundreds of IPC/s to ~30-60). */
const EMIT_BATCH_MS = 8;
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
const PROCESS_TREE_KILL_TIMEOUT_MS = 5000;

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

export type ProcessTreeKillFn = (pid: number) => Promise<void>;

function killWindowsProcessTree(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'taskkill.exe',
      ['/pid', String(pid), '/t', '/f'],
      { windowsHide: true, timeout: PROCESS_TREE_KILL_TIMEOUT_MS },
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

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

interface ManagedSession {
  info: SessionInfo;
  pty: IPty | null;
  outputSeq: number;
  disposables: IDisposable[];
  /** Last seq EMITTED to the renderer (-1 = none). Replay dedup boundary. */
  scrollbackLastSeq: number;
  idleTimer: NodeJS.Timeout | null;
  resizeQuietUntil: number;
  startupGraceUntil: number;
  inputQuietUntil: number;
  pendingEmit: { chunks: Buffer[]; totalBytes: number; lastSeq: number } | null;
  pendingEmitTimer: NodeJS.Timeout | null;
  headlessTerm: HeadlessTerminal | null;
  serializeAddon: SerializeAddon | null;
  closePromise: Promise<void> | null;
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
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly replayPreparations = new Map<string, Promise<void>>();
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
        ? process.platform === 'win32'
          ? killWindowsProcessTree
          : null
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

    const managed: ManagedSession = {
      info,
      pty,
      outputSeq: 0,
      disposables: [],
      scrollbackLastSeq: -1,
      idleTimer: null,
      resizeQuietUntil: 0,
      startupGraceUntil: Date.now() + STARTUP_GRACE_MS,
      inputQuietUntil: 0,
      pendingEmit: null,
      pendingEmitTimer: null,
      headlessTerm: new HeadlessTerminal({
        cols: info.cols,
        rows: info.rows,
        scrollback: SCROLLBACK_LINES,
        // Keep Codex's DEC 2026 + ED2 redraws in scrollback. This must match
        // TerminalView or a remount would replay a different buffer history.
        scrollOnEraseInDisplay: true,
        allowProposedApi: true,
      }),
      serializeAddon: null,
      closePromise: null,
    };
    const serializeAddon = new SerializeAddon();
    managed.headlessTerm!.loadAddon(serializeAddon);
    managed.serializeAddon = serializeAddon;
    this.sessions.set(sessionId, managed);

    managed.disposables.push(
      pty.onData((data) => this.handlePtyData(managed, data)),
      pty.onExit(({ exitCode, signal }) => this.handlePtyExit(managed, exitCode, signal)),
      // Live terminal title (OSC 0/2): the headless mirror parses every byte,
      // so its onTitleChange fires for each title sequence. The renderer's
      // xterm only exists for the shown session — tracking it here keeps every
      // session's title live and surviving switches (Marina TIT-1).
      managed.headlessTerm!.onTitleChange((title) => this.handleTitle(managed, title)),
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
    if (!managed.pty) return { accepted: false, reason: 'pty-exited' };
    const text = Buffer.from(base64Data, 'base64').toString('utf8');
    const now = Date.now();
    if (text.includes('\r') || text.includes('\n')) {
      managed.inputQuietUntil = 0;
    } else {
      managed.inputQuietUntil = now + INPUT_QUIET_MS;
    }
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
    if (!managed.pty) return { accepted: false, reason: 'pty-exited' };
    const dims = validateDimensions(cols, rows);
    managed.resizeQuietUntil = Date.now() + RESIZE_QUIET_MS;
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
    const previous = this.replayPreparations.get(sessionId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.replayPreparations.set(sessionId, current);
    await previous;

    try {
      return await this.prepareReplayNow(sessionId, cols, rows);
    } finally {
      release();
      if (this.replayPreparations.get(sessionId) === current) {
        this.replayPreparations.delete(sessionId);
      }
    }
  }

  private async prepareReplayNow(
    sessionId: string,
    cols: number,
    rows: number,
  ): Promise<SessionReplaySnapshot> {
    const managed = this.sessions.get(sessionId);
    if (!managed || !managed.headlessTerm || !managed.serializeAddon) {
      const dims = validateDimensions(cols, rows);
      return { data: '', lastSeq: -1, ...dims };
    }
    const term = managed.headlessTerm;
    const addon = managed.serializeAddon;
    const dims = validateDimensions(cols, rows);

    managed.resizeQuietUntil = Date.now() + RESIZE_QUIET_MS;
    const altBufferActive = term.buffer.active.type === 'alternate';
    if (managed.pty && altBufferActive) {
      const redrawDeadline = Date.now() + REPLAY_REDRAW_CAP_MS;
      managed.resizeQuietUntil = redrawDeadline + RESIZE_QUIET_MS;
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

    if (managed.pendingEmitTimer) {
      clearTimeout(managed.pendingEmitTimer);
      managed.pendingEmitTimer = null;
    }
    this.flushPendingEmit(managed);
    // Freeze the replay boundary before inserting the parser fence. Any PTY
    // bytes that arrive after this point are written behind the fence, so the
    // snapshot below cannot contain them even if their IPC batch is emitted
    // while we are waiting for the fence/serialize work.
    const replayLastSeq = managed.scrollbackLastSeq;
    await new Promise<void>((resolve) => {
      let settled = false;
      let fenceTimer: ReturnType<typeof setTimeout> | null = null;
      const done = (capped: boolean): void => {
        if (settled) return;
        settled = true;
        if (fenceTimer) clearTimeout(fenceTimer);
        if (capped) logger.warn('session', `replay fence capped sid=${sessionId} (callback dropped?)`);
        resolve();
      };
      fenceTimer = setTimeout(() => done(true), REPLAY_FENCE_CAP_MS);
      term.write(new Uint8Array(0), () => done(false));
    });

    let ansi = addon.serialize({ scrollback: SCROLLBACK_LINES });

    // xterm-serialize mode polyfill (Marina): older serializers miss cursor
    // visibility (?25l) and DECSTBM. Harmless if the addon already emits
    // them; vital for TUIs (hidden cursor / scroll regions) if not.
    const core = (
      term as unknown as {
        _core?: {
          coreService?: { isCursorHidden?: boolean };
          buffer?: { scrollTop?: number; scrollBottom?: number };
        };
      }
    )._core;
    if (core?.coreService?.isCursorHidden) {
      ansi += '\x1b[?25l';
    }
    const top = core?.buffer?.scrollTop;
    const bot = core?.buffer?.scrollBottom;
    if (typeof top === 'number' && typeof bot === 'number' && (top !== 0 || bot !== term.rows - 1)) {
      ansi += `\x1b[${top + 1};${bot + 1}r`;
    }
    const data = Buffer.from(ansi, 'utf8').toString('base64');

    return {
      data,
      lastSeq: replayLastSeq,
      cols: dims.cols,
      rows: dims.rows,
    };
  }

  private applyDimensions(
    managed: ManagedSession,
    cols: number,
    rows: number,
    updateInfo: boolean,
  ): void {
    managed.pty?.resize(cols, rows);
    try {
      managed.headlessTerm?.resize(cols, rows);
    } catch {
      /* headless resize must never block the real one */
    }
    if (updateInfo) {
      managed.info.cols = cols;
      managed.info.rows = rows;
    }
  }

  private async resizeAndWaitForOutput(
    managed: ManagedSession,
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

    const waiter = this.createOutputQuietWaiter(managed.info.id, managed.outputSeq, quietMs, capMs);
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

  private handlePtyData(managed: ManagedSession, data: string): void {
    // ConPTY can emit one final onData after teardown started.
    if (!this.sessions.has(managed.info.id) || !managed.pty) return;
    const bytes = Buffer.from(data, 'utf8');
    if (bytes.length === 0) return;

    const seq = managed.outputSeq++;
    this.queueEmit(managed, bytes, seq);

    // Feed the headless mirror (async parse; replay paths drain first).
    managed.headlessTerm?.write(data);

    // State machine: bytes mean active — unless a quiet window says these
    // bytes are echo/banner/reflow, in which case the state stays put
    // (scrollback and renderer output are unaffected either way).
    const now = Date.now();
    if (
      now >= managed.resizeQuietUntil &&
      now >= managed.startupGraceUntil &&
      now >= managed.inputQuietUntil
    ) {
      this.markActive(managed);
    }
  }

  /** PER-2 invariant: scrollbackLastSeq and the emitted bytes advance
   *  together; pending bytes are invisible to the renderer. */
  private queueEmit(managed: ManagedSession, bytes: Buffer, seq: number): void {
    if (managed.pendingEmit === null) {
      managed.pendingEmit = { chunks: [bytes], totalBytes: bytes.length, lastSeq: seq };
    } else {
      managed.pendingEmit.chunks.push(bytes);
      managed.pendingEmit.totalBytes += bytes.length;
      managed.pendingEmit.lastSeq = seq;
    }
    if (managed.pendingEmitTimer === null) {
      managed.pendingEmitTimer = setTimeout(() => {
        managed.pendingEmitTimer = null;
        this.flushPendingEmit(managed);
      }, EMIT_BATCH_MS);
    }
  }

  private flushPendingEmit(managed: ManagedSession): void {
    if (!managed.pendingEmit) return;
    const { chunks, totalBytes, lastSeq } = managed.pendingEmit;
    managed.pendingEmit = null;
    const bytes = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, totalBytes);
    managed.scrollbackLastSeq = lastSeq;
    const payload: SessionOutputPayload = {
      scope: this.scopeOf(managed),
      sessionId: managed.info.id,
      data: bytes.toString('base64'),
      seq: lastSeq,
    };
    this.emit('sessionOutput', payload);
  }

  private flushPendingEmitBeforeLifecycleChange(managed: ManagedSession): void {
    if (managed.pendingEmitTimer) {
      clearTimeout(managed.pendingEmitTimer);
      managed.pendingEmitTimer = null;
    }
    if (managed.pendingEmit) {
      this.flushPendingEmit(managed);
    }
  }

  private handlePtyExit(managed: ManagedSession, exitCode: number, signal: number | undefined): void {
    if (!this.sessions.has(managed.info.id)) return;
    if (managed.info.state === 'exited') return;

    // Causal order for the renderer: last output → exited, never reversed.
    this.flushPendingEmitBeforeLifecycleChange(managed);

    const payload: SessionExitedPayload = {
      scope: this.scopeOf(managed),
      sessionId: managed.info.id,
      exitCode,
      ...(typeof signal === 'number' ? { signal } : {}),
    };
    this.emit('sessionExited', payload);

    managed.info.state = 'exited';
    managed.info.exitCode = exitCode;
    managed.info.exitedAt = Date.now();
    this.clearTimers(managed);
    managed.pty = null;

    this.emitStateChanged(managed, {
      state: 'exited',
      exitCode,
      exitedAt: managed.info.exitedAt,
      pid: -1,
    });
  }

  private destroySession(
    managed: ManagedSession,
    reason: 'user-closed' | 'project-switched' | 'app-quit',
  ): Promise<void> {
    const sid = managed.info.id;
    if (!this.sessions.has(sid)) return Promise.resolve();
    if (managed.closePromise) return managed.closePromise;

    managed.closePromise = this.destroySessionNow(managed, reason);
    return managed.closePromise;
  }

  private async destroySessionNow(
    managed: ManagedSession,
    reason: 'user-closed' | 'project-switched' | 'app-quit',
  ): Promise<void> {
    const sid = managed.info.id;

    this.flushPendingEmitBeforeLifecycleChange(managed);
    this.clearTimers(managed);

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
    if (managed.headlessTerm) {
      try {
        managed.headlessTerm.dispose();
      } catch {
        /* ignore */
      }
      managed.headlessTerm = null;
    }
    managed.serializeAddon = null;
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

  // ──────────────────────────────────────────────────────────────────
  // Internal: active/idle
  // ──────────────────────────────────────────────────────────────────

  private markActive(managed: ManagedSession): void {
    if (managed.info.state === 'exited') return;
    if (managed.info.state !== 'active') {
      managed.info.state = 'active';
      this.emitStateChanged(managed, { state: 'active' });
    }
    this.scheduleIdleCheck(managed);
  }

  private scheduleIdleCheck(managed: ManagedSession): void {
    if (managed.idleTimer) clearTimeout(managed.idleTimer);
    const thresholdSec = this.settingsManager.get().advanced.activeIdleThresholdSeconds;
    const ms = Math.max(100, thresholdSec * 1000);
    managed.idleTimer = setTimeout(() => {
      managed.idleTimer = null;
      if (managed.info.state !== 'active') return;
      managed.info.state = 'idle';
      this.emitStateChanged(managed, { state: 'idle' });
    }, ms);
  }

  private clearTimers(managed: ManagedSession): void {
    if (managed.idleTimer) {
      clearTimeout(managed.idleTimer);
      managed.idleTimer = null;
    }
    if (managed.pendingEmitTimer) {
      clearTimeout(managed.pendingEmitTimer);
      managed.pendingEmitTimer = null;
    }
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
  private handleTitle(managed: ManagedSession, rawTitle: string): void {
    if (managed.info.state === 'exited') return;
    const cleaned = sanitizeTitle(rawTitle);
    if (!cleaned) return;
    if (looksLikeShellStartupGarbage(cleaned)) return;
    if (cleaned === managed.info.terminalTitle) return;
    managed.info.terminalTitle = cleaned;
    this.emitStateChanged(managed, { terminalTitle: cleaned });
  }

  private emitStateChanged(managed: ManagedSession, patch: Partial<SessionInfo>): void {
    const payload: SessionStateChangedPayload = {
      scope: this.scopeOf(managed),
      sessionId: managed.info.id,
      patch,
    };
    this.emit('sessionStateChanged', payload);
  }

  private scopeOf(managed: ManagedSession): ProjectScope {
    return {
      root: managed.info.projectRoot,
      generation: managed.info.projectGeneration,
    };
  }
}

/**
 * OSC 0/2 title normalization: replace control + DEL + Unicode bidi-override
 * chars with spaces (the latter blocks RTL-override spoofing of the banner),
 * collapse runs of whitespace, trim, cap at 100 chars. Empty → '' (caller
 * skips). Ported from Marina.
 */
const TITLE_MAX_LEN = 100;
function sanitizeTitle(raw: string): string {
  let s = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) {
      s += ' ';
      continue;
    }
    if (
      code === 0x200b ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      s += ' ';
      continue;
    }
    s += ch;
  }
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > TITLE_MAX_LEN) s = s.slice(0, TITLE_MAX_LEN);
  return s;
}

/**
 * Whether a title is "startup garbage" — a bare path/exe a shell sets on
 * launch, not a real program title. Real CLI titles are verb-leading
 * ("vim C:\foo", "✻ Claude …") and never start with a bare drive/UNC/`/`
 * prefix, so a `^` anchor is enough to tell them apart. Ported from Marina.
 */
export function looksLikeShellStartupGarbage(title: string): boolean {
  // Windows drive path — "C:\…" / "D:/…"
  if (/^[A-Za-z]:[\\/]/.test(title)) return true;
  // UNC path — "\\server\share\…"
  if (/^\\\\/.test(title)) return true;
  // Unix absolute path — "/usr/bin/bash"
  if (title.startsWith('/')) return true;
  // Git Bash / MSYS2 default PS1 prefix, re-sent every prompt
  if (/^(MINGW(32|64|ARM)?|MSYS\d?):/i.test(title)) return true;
  // Bare exe filename — "cmd.exe" / "pwsh.exe"
  if (/^\S+\.exe$/i.test(title)) return true;
  return false;
}
