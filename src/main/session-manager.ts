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
 * Iris-specific: FOCUS_DOC env injection — the whole point of the core
 * gesture. Dynamic focus rides process env (lives and dies with the
 * session); static contracts ride the constitution files. Two lifetimes,
 * two pipes.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { spawn as defaultSpawnPty, type IPty, type IDisposable } from 'node-pty';
import type {
  AgentConfig,
  SessionExitedPayload,
  SessionInfo,
  SessionOutputPayload,
  SessionStateChangedPayload,
} from '@shared/types';
import type { SettingsManager } from './settings-manager';
import { buildSpawnEnv, injectTerminalHintEnv, validateDimensions } from './pty-utils';
import { logger } from './logger';
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
  pendingEmit: { bytes: Buffer; lastSeq: number } | null;
  pendingEmitTimer: NodeJS.Timeout | null;
  headlessTerm: HeadlessTerminal | null;
  serializeAddon: SerializeAddon | null;
}

export interface CreateSessionInput {
  /** Doc rel path (forward slashes) or null for a project-root session. */
  docPath: string | null;
  agentId: string;
  projectRoot: string;
  cols: number;
  rows: number;
}

/**
 * Locate the shell that hosts agent commands. Windows: pwsh → powershell →
 * cmd, probed on PATH via the spawn env. POSIX: $SHELL → /bin/bash.
 */
function resolveHostShell(env: Record<string, string>): {
  file: string;
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
              command ? ['-NoLogo', '-Command', command] : ['-NoLogo'],
          };
        }
      }
    }
    return {
      file: 'cmd.exe',
      buildArgs: (command) => (command ? ['/c', command] : []),
    };
  }
  const shell = process.env.SHELL || '/bin/bash';
  return {
    file: shell,
    buildArgs: (command) => (command ? ['-lc', command] : ['-l']),
  };
}

export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly spawnFn: PtySpawnFn;

  constructor(
    private readonly settingsManager: SettingsManager,
    options?: { spawnFn?: PtySpawnFn },
  ) {
    super();
    this.spawnFn = options?.spawnFn ?? (defaultSpawnPty as PtySpawnFn);
  }

  createSession(input: CreateSessionInput): SessionInfo {
    const settings = this.settingsManager.get();
    const agent: AgentConfig | undefined = settings.agents.find((a) => a.id === input.agentId);
    if (!agent) {
      throw new SessionManagerError('AgentNotFound', `agentId="${input.agentId}" 不在设置的 agents 清单里`);
    }
    const dims = validateDimensions(input.cols, input.rows);
    const cwd = input.projectRoot;
    try {
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
        throw new SessionManagerError('CwdNotAccessible', `项目根 "${cwd}" 不存在或不是目录`, { cwd });
      }
    } catch (err) {
      if (err instanceof SessionManagerError) throw err;
      throw new SessionManagerError('CwdNotAccessible', `读取项目根 "${cwd}" 失败`, { cwd });
    }

    const env = buildSpawnEnv(process.env, SPAWN_ENV_SKIP);
    injectTerminalHintEnv(env, { programName: 'Iris' });
    // The core gesture: dynamic focus rides the process environment.
    // Bare launch — no prompt is sent; opening is not running.
    if (input.docPath) {
      env.FOCUS_DOC = input.docPath;
    } else {
      delete env.FOCUS_DOC; // root fallback session must NOT inherit one
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
      });
    } catch (err) {
      throw new SessionManagerError(
        'PtySpawnFailed',
        `无法启动 "${host.file}" (agent=${agent.id}) cwd="${cwd}": ${
          err instanceof Error ? err.message : String(err)
        }`,
        { shellPath: host.file, cwd },
      );
    }

    const sessionId = randomUUID();
    const info: SessionInfo = {
      id: sessionId,
      docPath: input.docPath,
      agentId: agent.id,
      displayName: agent.label,
      projectRoot: cwd,
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
        allowProposedApi: true,
      }),
      serializeAddon: null,
    };
    const serializeAddon = new SerializeAddon();
    managed.headlessTerm!.loadAddon(serializeAddon);
    managed.serializeAddon = serializeAddon;
    this.sessions.set(sessionId, managed);

    managed.disposables.push(
      pty.onData((data) => this.handlePtyData(managed, data)),
      pty.onExit(({ exitCode, signal }) => this.handlePtyExit(managed, exitCode, signal)),
    );

    this.emit('sessionCreated', { ...info });
    return { ...info };
  }

  /** Close & destroy (user gesture or app quit) — the only removal path. */
  closeSession(sessionId: string): void {
    const managed = this.sessions.get(sessionId);
    if (!managed) return;
    this.destroySession(managed, 'user-closed');
  }

  shutdown(): void {
    for (const sid of [...this.sessions.keys()]) {
      const managed = this.sessions.get(sid);
      if (managed) this.destroySession(managed, 'app-quit');
    }
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

  /**
   * Resize. The quiet window opens even for a no-op resize: a remount
   * always fires one, and TUIs repaint on that poke — those bytes must not
   * flip an idle session active (Marina 勘误第二轮).
   */
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
    managed.info.cols = dims.cols;
    managed.info.rows = dims.rows;
    try {
      managed.pty.resize(dims.cols, dims.rows);
      try {
        managed.headlessTerm?.resize(dims.cols, dims.rows);
      } catch {
        /* headless resize must never block the real one */
      }
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
   * Ordering: flush pending emit → drain the headless parser (write('',cb)
   * is xterm's official fence) → serialize + read lastSeq synchronously.
   * Bytes arriving after the fence go through the normal 8ms batch and the
   * renderer filters seq > lastSeq — no loss, no double-write.
   */
  async getScrollbackForReplay(sessionId: string): Promise<{ data: string; lastSeq: number }> {
    const managed = this.sessions.get(sessionId);
    if (!managed || !managed.headlessTerm || !managed.serializeAddon) {
      return { data: '', lastSeq: -1 };
    }
    const term = managed.headlessTerm;
    const addon = managed.serializeAddon;

    this.flushPendingEmit(managed);
    await new Promise<void>((resolve) => {
      term.write('', () => resolve());
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

    return {
      data: Buffer.from(ansi, 'utf8').toString('base64'),
      lastSeq: managed.scrollbackLastSeq,
    };
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
      managed.pendingEmit = { bytes, lastSeq: seq };
    } else {
      managed.pendingEmit.bytes = Buffer.concat([managed.pendingEmit.bytes, bytes]);
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
    const { bytes, lastSeq } = managed.pendingEmit;
    managed.pendingEmit = null;
    managed.scrollbackLastSeq = lastSeq;
    const payload: SessionOutputPayload = {
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

  private destroySession(managed: ManagedSession, reason: 'user-closed' | 'app-quit'): void {
    const sid = managed.info.id;
    if (!this.sessions.has(sid)) return;

    this.flushPendingEmitBeforeLifecycleChange(managed);
    this.clearTimers(managed);
    for (const d of managed.disposables) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    if (managed.pty) {
      try {
        managed.pty.kill();
      } catch (err) {
        logger.warn('session', `kill failed sid=${sid}`, err);
      }
      managed.pty = null;
    }
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
    this.emit('sessionDestroyed', { sessionId: sid, reason });
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

  private emitStateChanged(managed: ManagedSession, patch: Partial<SessionInfo>): void {
    const payload: SessionStateChangedPayload = {
      sessionId: managed.info.id,
      patch,
    };
    this.emit('sessionStateChanged', payload);
  }
}
