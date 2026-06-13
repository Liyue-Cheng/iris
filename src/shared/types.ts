/**
 * @file src/shared/types.ts
 * @purpose Data models shared by main / preload / renderer.
 *
 * M0 scope: settings only. Session / document models arrive in M1/M3.
 */

/** v1 ships the three Rose Pine variants only (technical-design.md, 主题系统). */
export type ThemeId = 'rose-pine' | 'rose-pine-dawn' | 'rose-pine-moon';

export interface Settings {
  version: 1;
  appearance: {
    theme: ThemeId;
    /** UI font stack; LXGW WenKai inherited from the Marina design language. */
    uiFontFamily: string;
    /** Terminal font stack (consumed from M3 on, declared now for stability). */
    terminalFontFamily: string;
    terminalFontSize: number;
    /** xterm line-height multiplier (Marina default 1.2). */
    terminalLineHeight: number;
    /** Whole-window zoom. Applied by main via webContents.setZoomFactor —
     *  native Chromium zoom, so popup positioning math stays intact (CSS
     *  zoom is the known popover-misplacement trap). */
    uiZoom: number;
  };
  behavior: {
    /** Terminal selection lands on the clipboard automatically (Marina CPB-C2). */
    selectOnCopy: boolean;
    /** Terminal right click: context menu, or paste straight away. */
    terminalRightClick: 'menu' | 'paste';
    /** Confirm before closing the window while live sessions exist. */
    confirmOnQuit: boolean;
    /** Enable Crepe's BlockEdit feature: the hover block handle (＋ / drag)
     *  plus the bundled slash menu. Off by default — the handle repositions
     *  on every hovered block and reads as flicker. */
    editorBlockEdit: boolean;
  };
  project: {
    /** Absolute path of the last opened project; reopened on startup. */
    lastRoot: string | null;
  };
  /**
   * Agent CLIs offered by the "open with X" gesture. The shell is dumb:
   * these are plain command lines run in the user's own shell — no SDKs,
   * no keys (software-definition.md 哑壳).
   */
  agents: AgentConfig[];
  advanced: {
    /** active → idle silence threshold (Marina-tuned default 2s, min 0.1). */
    activeIdleThresholdSeconds: number;
    /** xterm renderer: 'auto' tries WebGL with DOM fallback; explicit
     *  overrides are the WebGL-compat escape hatch (Marina PER-LINUX).
     *  Applies to newly mounted terminals (sessions remount on switch). */
    terminalRenderer: 'auto' | 'webgl' | 'dom';
  };
}

export interface AgentConfig {
  id: string;
  /** Menu label, e.g. "claude". */
  label: string;
  /** Command line executed in the shell; '' means a bare shell. */
  command: string;
  /**
   * Context-injection channel (informational — the work happens elsewhere):
   * 'hook' = a SessionStart hook in the agent's own config calls the
   * focus-context script; 'flag' = the command line itself carries a flag
   * (e.g. aider --read $env:FOCUS_DOC); 'none'/absent = degrade to the
   * AGENTS.md guidance (the protocol's documented fallback).
   */
  injection?: 'hook' | 'flag' | 'none';
}

// ──────────────────────────────────────────────────────────────────
// Context-injection adapter state (round-3 A 条) — agent:injection-state
// ──────────────────────────────────────────────────────────────────

export type HookCliState =
  | 'cli-not-found' // config dir absent — CLI likely not installed
  | 'not-configured' // CLI present, no Iris hook yet
  | 'configured' // hook references the focus-context script
  | 'manual-only'; // detected, but Iris won't write this format (Codex TOML)

export interface HookCliInfo {
  id: string;
  label: string;
  configPath: string;
  state: HookCliState;
  /** Human-readable guidance (manual-only and error cases). */
  detail?: string;
}

export interface InjectionState {
  script: { path: string; exists: boolean; hookCommand: string };
  clis: HookCliInfo[];
}

/** Recursive partial, for settings updates. */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export interface SettingsChangedEvent {
  settings: Settings;
  /** Dotted paths of changed fields, e.g. "appearance.theme". */
  changedKeys: string[];
}

export interface PingResult {
  pong: true;
  echo: unknown;
  /** ISO timestamp produced by the main process. */
  time: string;
  /** Main-process pid — proves the round trip crossed process boundaries. */
  pid: number;
}

// ──────────────────────────────────────────────────────────────────
// Protocol data model (software-definition.md §3) — read side, M1
// ──────────────────────────────────────────────────────────────────

/** The four built-in typed folders. v1 has no custom types. */
export type DocType = 'status' | 'issue' | 'report' | 'misc';

export const DOC_TYPES: readonly DocType[] = ['status', 'issue', 'report', 'misc'];

/**
 * One GFM task-list item, extracted by a literal line parse of a doc body
 * (fenced code excluded). The read side of the todo panel.
 */
export interface DocTodo {
  /** 0-based line index in the FULL file text (frontmatter lines included). */
  line: number;
  checked: boolean;
  /** Task text with list marker and checkbox stripped (display form). */
  text: string;
  /**
   * The exact line as scanned, without its EOL. Write-side surgery compares
   * this against the line on disk before toggling — mismatch means the doc
   * changed since the scan, so refuse and wait for the next scan.
   */
  raw: string;
}

/**
 * One markdown document inside a typed folder. All paths are relative to
 * the project root with forward slashes (the protocol's portable form;
 * conversion to OS paths happens at the fs boundary in main).
 */
export interface IrisDoc {
  /** e.g. ".iris/issue/2026-06-10-auth-refactor.md" */
  path: string;
  /** File name, e.g. "2026-06-10-auth-refactor.md" */
  name: string;
  /** Resolved via the nearest enclosing typed folder. */
  type: DocType;
  /** Path of the owning workspace dir, e.g. ".iris" or ".iris/spike-auth". */
  workspacePath: string;
  /** frontmatter `title:`, null when absent/unparseable. */
  title: string | null;
  /** frontmatter `status:` — a SOFT value; render literally, never validate. */
  status: string | null;
  /** Full parsed frontmatter (null when absent or broken). */
  frontmatter: Record<string, unknown> | null;
  /** True when frontmatter exists but failed to parse — degrade, don't hide. */
  frontmatterBroken: boolean;
  /**
   * frontmatter `labels:` — SOFT values passed through verbatim. A YAML
   * sequence yields its items; a lone scalar yields a singleton (literal
   * parse, no comma-splitting heuristics); absent/other shapes yield [].
   */
  labels: string[];
  /** GFM task-list items in the body (read side of the todo panel). */
  todos: DocTodo[];
  mtimeMs: number;
}

/**
 * A workspace: any folder containing at least one typed folder. Inferred,
 * never declared (no manifest, no registry). `.iris/` is the root workspace.
 */
export interface IrisWorkspace {
  /** Relative dir path, e.g. ".iris" or ".iris/spike-auth". */
  path: string;
  /** Display name: folder name; the root workspace shows the project name. */
  name: string;
  /** Docs owned by this workspace (nearest-workspace rule), grouped by type at render time. */
  docs: IrisDoc[];
  /** Nested workspaces (recursive). */
  children: IrisWorkspace[];
  /**
   * True when this workspace sits inside an ancestor's report/ folder —
   * the archive gesture: a finished workspace moved into report/ freezes
   * whole (renders grayed).
   */
  archived: boolean;
}

export interface IrisScanResult {
  /** Absolute project root (OS form, display only). */
  projectRoot: string;
  /** Project folder name (root workspace display name). */
  projectName: string;
  /** False when no .iris/ directory exists. */
  hasIris: boolean;
  root: IrisWorkspace | null;
  /**
   * Constitution presence + declared protocol version. The app only ever
   * PROMPTS on mismatch — upgrading the constitution is a human gesture.
   */
  constitution: { exists: boolean; protocol: number | null };
  scannedAt: number;
}

/** project.init result — what the idempotent scaffold actually did. */
export interface ProjectInitResult {
  createdFolders: string[];
  constitution: 'created' | 'already-exists';
  agentsMd: 'created' | 'appended' | 'already-has-section';
}

/** Raw file-tree escape hatch (left pane toggle). */
export interface RawTreeNode {
  name: string;
  /** Relative path from project root, forward slashes. */
  path: string;
  kind: 'dir' | 'file';
  children?: RawTreeNode[];
}

/** doc:read response — frontmatter split from body for rendering. */
export interface DocContent {
  path: string;
  /** Raw file text (source-mode / fallback rendering). */
  raw: string;
  /** Body with frontmatter stripped. */
  body: string;
  frontmatter: Record<string, unknown> | null;
  frontmatterBroken: boolean;
}

// ──────────────────────────────────────────────────────────────────
// Sessions (M3) — model ported from Marina, anchor changed path → doc
// ──────────────────────────────────────────────────────────────────

/**
 * active = a command is producing real output (quiet windows filtered)
 * idle   = waiting at a prompt / waiting for user input
 * exited = process ended; scrollback retained until the user closes it
 */
export type SessionState = 'active' | 'idle' | 'exited';

export interface SessionInfo {
  id: string;
  /**
   * The anchor (借鉴 Marina 的 path↔会话 → 文档↔会话): doc rel path, fixed
   * at creation for the session's whole life. null = project-root session
   * (no FOCUS_DOC injected — the unfocused fallback).
   */
  docPath: string | null;
  agentId: string;
  displayName: string;
  projectRoot: string;
  cols: number;
  rows: number;
  pid: number;
  state: SessionState;
  createdAt: number;
  exitCode?: number;
  exitedAt?: number;
}

export interface SessionOutputPayload {
  sessionId: string;
  /** base64 PTY bytes (8ms aggregation window in main). */
  data: string;
  /** Monotonic per-session sequence of the LAST chunk in this batch. */
  seq: number;
}

export interface SessionStateChangedPayload {
  sessionId: string;
  patch: Partial<SessionInfo>;
}

export interface SessionExitedPayload {
  sessionId: string;
  exitCode: number;
  signal?: number;
}

/** Batched fs change notification pushed by main (already debounced). */
export interface FsIrisChangedEvent {
  projectRoot: string;
  /** Coarse change kinds; M1 projections just rescan. */
  changes: Array<{ kind: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'; path: string }>;
}
