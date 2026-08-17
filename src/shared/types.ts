/**
 * @file src/shared/types.ts
 * @purpose Data models shared by main / preload / renderer.
 *
 * M0 scope: settings only. Session / document models arrive in M1/M3.
 */

/** Theme ids shared by settings, CSS palettes, and xterm. */
export type ThemeId =
  | 'rose-pine'
  | 'rose-pine-dawn'
  | 'rose-pine-moon'
  | 'cutie'
  | 'business'
  | 'ubuntu'
  | 'windows-terminal'
  | 'one-dark-pro'
  | 'dracula'
  | 'tokyo-night'
  | 'catppuccin-mocha'
  | 'catppuccin-latte'
  | 'tokyo-night-day'
  | 'light-pink'
  | 'fairyfloss';

export type EditorConflictPolicy = 'ask' | 'overwrite';
export type LocalePreference = 'system' | 'zh-CN' | 'en-US';
export type AppLocale = Exclude<LocalePreference, 'system'>;

export interface Settings {
  version: 1;
  locale: LocalePreference;
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
    /** Restore the projects that were open at last quit. Off by default so
     *  startup lands on the welcome page and its recent-project list. */
    restoreProjectsOnStartup: boolean;
    /** Terminal selection lands on the clipboard automatically (Marina CPB-C2). */
    selectOnCopy: boolean;
    /** Terminal right click: context menu, or paste straight away. */
    terminalRightClick: 'menu' | 'paste';
    /** Dragging an Iris document into the terminal pastes either its project-
     *  relative path or the existing metadata-prefixed content snapshot. */
    terminalDocDrop: 'path' | 'content';
    /** Check every GFM task checkbox when an issue transitions to Done. */
    autoCheckTodosOnDone: boolean;
    /** Confirm before closing the window while live sessions exist. */
    confirmOnQuit: boolean;
    /** Enable Crepe's BlockEdit feature: the hover block handle (＋ / drag)
     *  plus the bundled slash menu. Off by default — the handle repositions
     *  on every hovered block and reads as flicker. */
    editorBlockEdit: boolean;
    /** Body text column alignment in the doc editor: 'center' keeps the
     *  reading column centered (default); 'left' hugs it to the left.
     *  The typed header's title/controls track the column either way. */
    editorBodyAlign: 'center' | 'left';
    /** Doc reading-column max-width, in rem. Drives both the Crepe body and
     *  the typed header (single source via the --editor-max-width CSS var).
     *  UI presets: 窄 48 / 中 58 (default) / 宽 72. Clamped to [30, 120]. */
    editorMaxWidth: number;
    /** Save user-authored body/source changes after an idle delay. Explicit
     *  commits, view switches, project switches and quit still flush. */
    editorAutosave: boolean;
    /** Idle delay for editorAutosave, clamped to [300, 10000] ms. */
    editorAutosaveDelayMs: number;
    /** Flush a genuinely dirty editor when focus leaves the editor body. */
    editorSaveOnBlur: boolean;
    /** External disk change while dirty: ask blocks writes and shows recovery
     *  actions; overwrite preserves the historical last-writer-wins policy. */
    editorConflictPolicy: EditorConflictPolicy;
  };
  project: {
    /** @deprecated v1.0 single-window field. v1.1 restores from openRoots;
     *  still written (= the most recently bound root) for back-compat. */
    lastRoot: string | null;
    /** Absolute paths of the projects open at last quit — one window restored
     *  per entry on startup (multi-window). Empty → a single empty window. */
    openRoots: string[];
    /** Most-recently-used project folders. Independent from openRoots so
     *  closing a window never erases the welcome page's history. */
    recentRoots: string[];
    /** Machine-local trust for executable project settings. Keyed by the
     * canonical project root; value is the approved project-settings revision. */
    commandTrust: Record<string, string>;
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

/** Read-side projection for one welcome-page recent project row. */
export interface RecentProject {
  path: string;
  name: string;
  /** True only when the path is currently accessible and is a directory. */
  exists: boolean;
}

export interface AgentConfig {
  id: string;
  /** Menu label, e.g. "claude". */
  label: string;
  /** Command line executed in the shell; '' means a bare shell. */
  command: string;
}

/**
 * App-owned launcher templates. They populate settings but never own a
 * launcher after it has been added: users can edit, duplicate, reorder, or
 * remove every field. Context adapters are intentionally a separate registry.
 */
export const AGENT_PRESETS: readonly AgentConfig[] = [
  { id: 'claude', label: 'claude', command: 'claude' },
  { id: 'codex', label: 'codex', command: 'codex' },
  { id: 'gemini', label: 'gemini', command: 'gemini' },
  { id: 'qwen', label: 'qwen', command: 'qwen' },
  { id: 'cursor', label: 'cursor', command: 'cursor-agent' },
  { id: 'pi', label: 'pi', command: 'pi' },
  {
    id: 'aider',
    label: 'aider',
    command: 'aider --read $env:FOCUS_DOC',
  },
  {
    id: 'goose',
    label: 'goose',
    command:
      'goose run --interactive --system "$((powershell -NoProfile -ExecutionPolicy Bypass -File \\"$env:USERPROFILE/.iris/focus-context.ps1\\") -join \\"`n\\")"',
  },
  { id: 'shell', label: 'terminal', command: '' },
];

// ──────────────────────────────────────────────────────────────────
// Context-injection adapter state (round-3 A 条) — agent:injection-state
// ──────────────────────────────────────────────────────────────────

export type HookCliState =
  | 'cli-not-found' // config dir absent — CLI likely not installed
  | 'not-configured' // CLI present, no Iris hook yet
  | 'stale' // an Iris hook exists, but its handler no longer matches the shipped definition
  | 'configured'; // hook matches the current shipped definition

export type FocusScriptState =
  | 'missing'
  | 'stale'
  | 'current';

export interface HookCliInfo {
  id: string;
  label: string;
  configPath: string;
  state: HookCliState;
  /** Human-readable guidance for setup or verification. */
  detail?: string;
}

export interface InjectionState {
  script: { path: string; state: FocusScriptState; hookCommand: string };
  clis: HookCliInfo[];
}

// ──────────────────────────────────────────────────────────────────
// Prompt governance (issue: iris软件提示词治理) — software-prompt:* channels
// ──────────────────────────────────────────────────────────────────

/** State of the `<iris-software>` block in one entry file.
 *  - no-entry: the file does not exist (AGENTS.md can be created).
 *  - missing : file exists but carries no block.
 *  - drifted : body differs from the built-in source or the tag has attrs.
 *  - ok      : attribute-free block with the exact built-in body. */
export type SoftwareBlockStateUi =
  | 'no-entry'
  | 'missing'
  | 'drifted'
  | 'duplicate'
  | 'write-failed'
  | 'ok';

export interface SoftwareEntryStatus {
  /** Project-root-relative path. */
  path: string;
  /** The standard entry Iris owns (AGENTS.md); vendor entries are false. */
  isStandard: boolean;
  state: SoftwareBlockStateUi;
}

export type ProjectPromptStateUi =
  | 'missing'
  | 'synced'
  | 'conflict'
  | 'drifted'
  | 'partial'
  | 'invalid-settings';

export interface ProjectPromptConflict {
  path: string;
  text: string;
}

export type ProjectPromptEntryState =
  | 'synced'
  | 'missing'
  | 'drifted'
  | 'duplicate'
  | 'write-failed';

export interface ProjectPromptEntryStatus {
  path: string;
  isStandard: boolean;
  state: ProjectPromptEntryState;
  text: string | null;
  error: string | null;
}

export interface SoftwarePromptState {
  /** Canonical app-owned software block, independent of any on-disk drift. */
  softwareText: string;
  entries: SoftwareEntryStatus[];
  /** Supported entry files not currently enrolled in this project's projection set. */
  availableEntries: string[];
  project: {
    state: ProjectPromptStateUi;
    text: string;
    conflicts: ProjectPromptConflict[];
    entries: ProjectPromptEntryStatus[];
    error: string | null;
  };
}

/** One governed prompt layer's on-disk text (null = file absent). */
export interface PromptLayerContent {
  text: string | null;
  /** Display path shown in the `<iris-*>` tag. */
  path: string;
}

/**
 * Read-only prompt view for settings. Static software/project text comes from
 * entry files; `assembled` contains only the dynamic SessionStart hook output.
 */
export interface ContextPreview {
  /** The standard entry's block; onDisk=false shows the built-in preview. */
  software: { block: string; onDisk: boolean };
  project: PromptLayerContent;
  assembled: string;
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

export type AppBuildType = 'dev' | 'portable' | 'installed';

export type AppLegalDocumentId = 'license' | 'thirdPartyNotices';

export type AppExternalLinkId = 'source' | 'releases' | 'issues';

/** Trusted product and runtime facts assembled by the main process. */
export interface AppInfo {
  name: string;
  version: string;
  buildType: AppBuildType;
  platform: string;
  arch: string;
  electronVersion: string;
  chromiumVersion: string;
  nodeVersion: string;
  userDataPath: string;
  license: 'MIT';
  copyright: string;
  links: Record<AppExternalLinkId, string>;
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
  scannedAt: number;
}

/** Identity of the project currently committed to one renderer window. */
export interface ProjectScope {
  /** Canonical absolute root used by main for all project-bound operations. */
  root: string;
  /** Monotonic per-window generation; changes only on a real root switch. */
  generation: number;
}

// ──────────────────────────────────────────────────────────────────
// Project-level App settings (.iris/settings.json)
// ──────────────────────────────────────────────────────────────────

export type ProjectCommandTerminal = 'iris' | 'system';

export interface ProjectToolbarAction {
  /** Canonical Lucide icon slug, e.g. "rocket" or "database-backup". */
  icon: string;
  /** Human-facing tooltip, accessible name, and overflow-menu label. */
  description: string;
  /** Plain command line executed by the user's host shell. */
  command: string;
  /** New Iris root-hub PTY, or an external operating-system terminal. */
  terminal: ProjectCommandTerminal;
}

export interface ProjectSettings {
  version: 1;
  prompts: {
    /** Canonical project guidance projected into managed entry-file blocks. */
    project: string;
  };
  agentContext: {
    /** Explicit project-root entry files receiving both managed prompt layers. */
    entries: string[];
  };
  toolbar: {
    /** Array order is toolbar order; actions deliberately have no stored id. */
    actions: ProjectToolbarAction[];
  };
}

export interface ProjectSettingsSnapshot {
  settings: ProjectSettings;
  /** SHA-256 of the exact file bytes, or "missing" before first save. */
  revision: string;
  exists: boolean;
  /** Invalid individual actions are omitted from settings and reported here. */
  diagnostics: string[];
  /** Whole-file parse/schema failures block edits until repaired on disk. */
  error: string | null;
  /** Derived from machine-level trust; never persisted in the project. */
  trusted: boolean;
}

export interface ProjectPromptUpdateResult {
  snapshot: ProjectSettingsSnapshot;
  prompt: SoftwarePromptState['project'];
}

export type ProjectCommandRunResult =
  | { kind: 'iris'; session: SessionInfo }
  | { kind: 'system'; pid: number };

/** Renderer boot distinguishes a requested first open from an already-live project. */
export interface WindowBootstrapState {
  requestedRoot: string | null;
  activeScope: ProjectScope | null;
}

/** project.init result — what the idempotent scaffold actually did. */
/** Per-file outcome of writing the `<iris-software>` managed block. */
export interface EntrySync {
  /** Project-root-relative path. */
  path: string;
  action: 'created' | 'updated' | 'unchanged';
}

export interface ProjectInitResult {
  createdFolders: string[];
  /** 'appended'/'updated' when AGENTS.md pre-existed; 'created' when written
   *  fresh; 'already-has-section' when its block was already current. */
  agentsMd: 'created' | 'appended' | 'updated' | 'already-has-section';
  /**
   * Vendor-specific entry files present at the project root (e.g. CLAUDE.md),
   * each synced with the `<iris-software>` block. Per the governance decision
   * Iris MAINTAINS the block in vendor entries that already exist; it never
   * creates an absent one (that would grow a zoo).
   */
  vendorEntries: EntrySync[];
  /** All vendor entry files detected at the root (superset of vendorEntries
   *  paths), kept for the UI's "a Claude/Codex/… entry exists" explanation. */
  foreignEntries: string[];
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
   * at creation for the session's whole life. null = workspace-hub session
   * (no FOCUS_DOC injected — the unfocused fallback). When null, workspacePath
   * names which workspace hub it belongs to.
   */
  docPath: string | null;
  /**
   * UI grouping for hub sessions (docPath null): which workspace's terminal
   * hub this belongs to — `.iris` for the project root, a workspace rel path
   * for a sub-workspace. null for doc-anchored sessions. Pure left-pane
   * grouping; NEVER injected as FOCUS_DOC and never persisted to disk (a
   * hub terminal is ephemeral and need not know its sub-workspace).
   */
  workspacePath: string | null;
  agentId: string;
  /** Stable agent label (e.g. "Claude") — identity, fixed at creation. */
  displayName: string;
  /**
   * Live terminal title reported by the program via OSC 0/2 (shell prompt,
   * Claude Code, vim …), updated in real time; null until the first title
   * event. The session banner shows this; displayName stays the agent label.
   */
  terminalTitle: string | null;
  projectRoot: string;
  projectGeneration: number;
  cols: number;
  rows: number;
  pid: number;
  state: SessionState;
  createdAt: number;
  exitCode?: number;
  exitedAt?: number;
}

export interface SessionOutputPayload {
  scope: ProjectScope;
  sessionId: string;
  /** base64 PTY bytes (8ms aggregation window in main). */
  data: string;
  /** Monotonic per-session sequence of the LAST chunk in this batch. */
  seq: number;
}

/** Atomic main-process snapshot prepared for one renderer replay size. */
export interface SessionReplaySnapshot {
  data: string;
  lastSeq: number;
  cols: number;
  rows: number;
}

export interface SessionStateChangedPayload {
  scope: ProjectScope;
  sessionId: string;
  patch: Partial<SessionInfo>;
}

export interface SessionExitedPayload {
  scope: ProjectScope;
  sessionId: string;
  exitCode: number;
  signal?: number;
}

export interface SessionDestroyedPayload {
  scope: ProjectScope;
  sessionId: string;
  reason: 'user-closed' | 'project-switched' | 'app-quit';
}

export interface SessionListSnapshot {
  scope: ProjectScope;
  sessions: SessionInfo[];
}

// ──────────────────────────────────────────────────────────────────
// Iris Agent sessions (second-stage MVP)
// ──────────────────────────────────────────────────────────────────

export type IrisAgentAnchor =
  | { kind: 'document'; path: string }
  | { kind: 'workspace'; path: string };

export type IrisAgentRuntimeState =
  | 'starting'
  | 'ready'
  | 'running'
  | 'waiting-tool'
  | 'stopping'
  | 'idle'
  | 'failed';

export type IrisAgentMessageRole = 'user' | 'assistant' | 'tool';

export interface IrisAgentMessage {
  id: string;
  turnId: string;
  role: IrisAgentMessageRole;
  content: string;
  createdAt: number;
  compact?: boolean;
  /** Retained for provider history reconstruction but hidden from the conversation UI. */
  providerOnly?: boolean;
  /** Exact Pi message used to reconstruct provider context after Worker replacement. */
  providerMessage?: Record<string, unknown>;
}

export interface IrisAgentToolEvent {
  id: string;
  turnId: string;
  requestId: string;
  name: 'read' | 'edit' | 'write' | 'terminal';
  state: 'running' | 'completed' | 'failed';
  createdAt: number;
  completedAt?: number;
  inputSummary: string;
  resultSummary?: string;
  error?: string;
  diff?: string;
  path?: string;
  terminalId?: string;
}

export interface IrisAgentFileEffect {
  id: string;
  turnId: string;
  toolCallId: string;
  path: string;
  kind: 'edit' | 'write';
  beforeSha256: string | null;
  afterSha256: string;
  beforeContent?: string;
  afterContent: string;
  createdAt: number;
}

export interface IrisAgentRequestFacts {
  id: string;
  turnId: string;
  createdAt: number;
  promptFingerprint: string;
  layerFingerprints: {
    agent: string;
    software: string;
    project: string;
    anchor: string;
  };
  anchor: IrisAgentAnchor;
  promptChars: number;
  redacted: true;
}

export interface IrisAgentUndoReceipt {
  commandId: string;
  removedTurnId: string;
  removedAt: number;
  resultingRevision: number;
  externalEffectsRetained: true;
}

export interface IrisAgentTurn {
  id: string;
  userMessageId: string;
  assistantMessageId?: string;
  requestId: string;
  /** Previous terminal attempt replaced by this retry. */
  retryOfTurnId?: string;
  /** @deprecated Legacy assembled-input marker. Never interpret as provider context. */
  promptAvailable?: true;
  artifactSchemaVersion?: 1;
  assembledInputAvailable?: true;
  assembledInputLegacy?: true;
  providerContextAvailable?: true;
  providerCallCount?: number;
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'rewound';
  createdAt: number;
  completedAt?: number;
  error?: string;
}

export interface IrisAgentSessionInfo {
  id: string;
  kind: 'iris-agent';
  anchor: IrisAgentAnchor;
  projectRoot: string;
  projectGeneration: number;
  displayName: string;
  state: IrisAgentRuntimeState;
  createdAt: number;
  updatedAt: number;
  /** Strictly monotonic canonical state revision. */
  revision: number;
  /** Identifies the only Worker generation allowed to mutate this Session. */
  workerEpoch: number;
  activeTurnId: string | null;
  /** Main-owned intent. While set, the target turn can only settle as stopped. */
  stopRequestedTurnId?: string;
  messages: IrisAgentMessage[];
  turns: IrisAgentTurn[];
  toolEvents: IrisAgentToolEvent[];
  fileEffects: IrisAgentFileEffect[];
  requestFacts: IrisAgentRequestFacts[];
  undoReceipts?: IrisAgentUndoReceipt[];
  /** Artifact deletions committed by Undo/Retry but not yet completed on disk. */
  pendingArtifactCleanupTurnIds?: string[];
  lastError?: string;
  selfHostingEligible: false;
}

export type IrisJsonValue =
  | string
  | number
  | boolean
  | null
  | IrisJsonValue[]
  | { [key: string]: IrisJsonValue };

export interface IrisAgentProviderContextCall {
  index: number;
  capturedAt: number;
  provider: string;
  model: string;
  api: string;
  payload: IrisJsonValue;
}

export interface IrisAgentProviderContextBundle {
  schemaVersion: 1;
  kind: 'provider-context-bundle';
  sessionId: string;
  turnId: string;
  requestId: string;
  createdAt: number;
  assembledInput: { available: boolean; legacy: false };
  contextStage: 'provider-payload';
  compaction: 'disabled';
  runtimeIdentity?: {
    appVersion: string;
    protocolVersion: number;
    sessionRevision: number;
    workerEpoch: number;
  };
  calls: Array<{
    index: number;
    capturedAt: number;
    provider: string;
    model: string;
    api: string;
    jsonFile: string;
    textFile: string;
    sha256: string;
  }>;
}

export interface IrisAgentListSnapshot {
  scope: ProjectScope;
  sessions: IrisAgentSessionInfo[];
}

export interface IrisAgentSessionChangedPayload {
  scope: ProjectScope;
  session: IrisAgentSessionInfo;
}

export interface IrisAgentSessionDestroyedPayload {
  scope: ProjectScope;
  sessionId: string;
}

/** One main-process commit result for initial open, same-root refresh, or switch. */
export interface ProjectOpenResult {
  scope: ProjectScope;
  scan: IrisScanResult;
  sessions: SessionInfo[];
  /** Configuration captured inside the same serialized project-open transaction. */
  projectSettings: ProjectSettingsSnapshot;
}

/** Batched fs change notification pushed by main (already debounced). */
export interface FsIrisChangedEvent {
  projectRoot: string;
  /** Added by the window broadcast adapter; absent only inside ProjectManager. */
  projectGeneration?: number;
  /** Coarse change kinds; M1 projections just rescan. */
  changes: Array<{ kind: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'; path: string }>;
}

/** Safe projection of a local image for the sandboxed renderer. */
export interface DocImageResult {
  dataUrl: string | null;
  error: 'invalid-path' | 'unsupported-type' | 'too-large' | 'read-failed' | null;
}

// ──────────────────────────────────────────────────────────────────
// Document companion assets
// ──────────────────────────────────────────────────────────────────

export type AssetHealth = 'referenced' | 'orphan' | 'missing' | 'unmanaged';
export type AssetKind = 'image' | 'attachment';

export interface AssetEntry {
  /** Project-relative disk path, or the resolved target for a missing item. */
  path: string;
  /** Literal Markdown URL when referenced; generated managed URL otherwise. */
  markdownUrl: string;
  name: string;
  kind: AssetKind;
  mimeType: string;
  size: number | null;
  referenceCount: number;
  health: AssetHealth;
}

export interface AssetInventory {
  docPath: string;
  /** Project-relative companion directory, whether or not it exists yet. */
  directoryPath: string;
  assets: AssetEntry[];
  counts: Record<AssetHealth, number>;
}

export interface AssetImportPayload {
  docPath: string;
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface AssetImportResult {
  path: string;
  markdownUrl: string;
  name: string;
  kind: AssetKind;
  mimeType: string;
  size: number;
  reused: boolean;
}

// ──────────────────────────────────────────────────────────────────
// Git Source Control
// ──────────────────────────────────────────────────────────────────

export type GitResourceGroup = 'merge' | 'index' | 'workingTree' | 'untracked';

export interface GitResource {
  path: string;
  originalPath?: string;
  /** Git porcelain XY status (or `??` for an untracked file). */
  status: string;
  group: GitResourceGroup;
}

export interface GitBranchInfo {
  name: string;
  current: boolean;
}

export type GitErrorCode =
  | 'GitUnavailable'
  | 'NotRepository'
  | 'UnsafeRepository'
  | 'PermissionDenied'
  | 'RepositoryLocked'
  | 'Timeout'
  | 'ConfigurationError'
  | 'NoStagedChanges'
  | 'HookFailed'
  | 'CommitRejected'
  | 'SigningFailed'
  | 'BranchConflict'
  | 'CommandFailed';

export interface GitSnapshotError {
  code: GitErrorCode;
  message: string;
  retryable: boolean;
}

export interface GitSnapshot {
  available: boolean;
  projectRoot: string | null;
  /** Absolute root of the complete worktree represented by this snapshot. */
  root: string | null;
  gitDir: string | null;
  commonDir: string | null;
  repositoryId: string | null;
  /** Monotonic within a repository identity; stale responses have lower revisions. */
  revision: number;
  /** The last valid projection is being shown after a refresh failure. */
  stale: boolean;
  branch: string | null;
  head: string | null;
  detached: boolean;
  ahead: number;
  behind: number;
  branches: GitBranchInfo[];
  groups: Record<GitResourceGroup, GitResource[]>;
  error: GitSnapshotError | null;
}

export interface GitChangedEvent {
  projectScope: ProjectScope | null;
}
