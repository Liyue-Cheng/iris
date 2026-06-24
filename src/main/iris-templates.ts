/**
 * @file src/main/iris-templates.ts
 * @purpose The protocol's canonical prose — split across the three governed
 *   layers (issue: iris软件提示词治理):
 *
 *   - SOFTWARE_PROMPT_TEMPLATE — the invariant protocol mechanics. App-owned,
 *     versioned, injected as the `<iris-software>` managed block. Users do not
 *     edit it; edits are detected as drift and offered for re-sync. Wording
 *     changes here are PROTOCOL changes — bump nothing silently.
 *   - CONSTITUTION_TEMPLATE — the project layer: policy that may differ per
 *     project (state-machine values, markdown style). Human-owned once written.
 *     LEGACY_CONSTITUTION_DEFAULTS keeps prior shipped versions so an untouched
 *     factory constitution can be recognized and offered an upgrade (§5).
 *   - MACHINE_CONVENTIONS_TEMPLATE — the user layer (machine facts).
 *
 *   The tag/sha/classification logic lives in software-prompt.ts; this file is
 *   just the prose + the frozen legacy archive.
 */

/** Current protocol version written into fresh constitutions and the
 *  `<iris-software>` block's `protocol=` attribute. */
export const PROTOCOL_VERSION = 1;

// ──────────────────────────────────────────────────────────────────
// Software layer — the `<iris-software>` managed-block body.
// ──────────────────────────────────────────────────────────────────

/**
 * The invariant protocol the agent must follow in ANY Iris project on ANY
 * machine. Injected verbatim inside `<iris-software>` (static, in AGENTS.md /
 * vendor entries) and re-asserted by the SessionStart hook. Project-specific
 * policy is NOT here — it lives in `.iris/CONVENTIONS.md`.
 */
export const SOFTWARE_PROMPT_TEMPLATE = `This project is managed with Iris — an AI-native, document-centric PM tool.
All PM artifacts are plain markdown files under \`.iris/\`, in typed folders.
The rules below are Iris's invariant protocol: they ship with the app and do
not vary per project. Project-specific policy lives in \`.iris/CONVENTIONS.md\`;
machine-specific facts live in \`~/.iris/CONVENTIONS.md\`.

## Folder semantics

Typed folders — \`status/\`, \`issue/\`, \`report/\`, \`misc/\` — may appear at any
depth. Any folder containing typed folders is a **workspace**; a document's
type is decided by the nearest enclosing typed folder.

- \`status/\` — Current state of the codebase; keep in sync with reality. Every
  status doc carries \`reflects: <git-commit-sha>\` in frontmatter.
- \`issue/\` — Things to do, bugs, open questions. Mark resolved via \`status:\`;
  do not delete.
- \`report/\` — Append-only snapshots and journals: never rewrite an existing
  report, add new files. Frontmatter may still change.
- \`misc/\` — Human scratch space. Do not touch unless asked.

## How context reaches you

Iris spawns your terminal with the environment variable \`FOCUS_DOC\` set to the
document the user is focused on (path relative to project root), and — for
agents with a SessionStart hook — injects a snapshot of the relevant files
directly, each wrapped in an \`<iris-…>\` tag:

- \`<iris-software>\` — this block (Iris protocol; app-owned, versioned).
- \`<iris-project>\` — \`.iris/CONVENTIONS.md\` (project policy).
- \`<iris-user>\` — \`~/.iris/CONVENTIONS.md\` (machine facts, if present).
- \`<iris-focus>\` — a snapshot of \`$FOCUS_DOC\`.

**The \`FOCUS_DOC\` env-var and reading these files from disk are a FALLBACK.**
If you already received a file's contents via the injected \`<iris-…>\` blocks
above, do not re-read it from disk — unless you have reason to believe it
changed (the injection is a snapshot taken at session start; the file may be
edited during the session, including by you). Agents without a hook fall back
to reading \`$FOCUS_DOC\` and the referenced files themselves.

## Working rules (invariant)

1. **Focus protocol.** If \`$FOCUS_DOC\` is set, read it first; its path tells you
   both its type and its workspace. Then wait for the user's instruction —
   loading context is not a task.
2. **Write-back scope.** Write results into the nearest workspace enclosing
   \`$FOCUS_DOC\`. Do not create new workspaces unless asked.
3. **Stamping.** After changing anything a status doc tracks, regenerate that
   doc and restamp \`reflects:\` with current \`git HEAD\`. After a git merge, do
   not hand-merge status docs — regenerate and restamp.
4. **No unsolicited files.** Never create a new file — reports included —
   unless the user explicitly asks. Editing the focused document is always
   fine, as are frontmatter updates (e.g. \`status:\` transitions) on existing
   docs.
5. **Naming.** New files in \`issue/\` and \`report/\` use a \`YYYY-MM-DD-<slug>\`
   prefix.
6. **Trust calibration.** Before relying on a status doc, compare its
   \`reflects:\` stamp to \`git HEAD\`; a large gap means treat it as a weak prior
   and verify against the code.
7. **Off-limits.** Never modify \`.iris/CONVENTIONS.md\` (the human-authored
   contract) or this \`<iris-software>\` block. Never write outside typed
   folders. Never touch code directories unless explicitly asked.

For project-specific policy — the issue/report state-machine values and the
markdown style to write in — read \`.iris/CONVENTIONS.md\`.`;

// ──────────────────────────────────────────────────────────────────
// Project layer — .iris/CONVENTIONS.md (slimmed to policy that varies).
// ──────────────────────────────────────────────────────────────────

/** Appendix B — .iris/CONVENTIONS.md (project constitution), project policy only. */
export const CONSTITUTION_TEMPLATE = `---
protocol: 1
---

# Iris Project Conventions

This file is the **project layer**: policy that may differ per project. The
invariant protocol (folder semantics, focus protocol, write-back scope) is
owned by Iris and injected separately as the \`<iris-software>\` block — you do
not need to restate it here. Keep this file short.

## State machine (\`status:\` field)

The stored value IS the displayed value — write it exactly as shown (deviate
only when reality demands).

- Issues: \`Todo\` → \`In Progress\` → \`In Review\` → \`Done\`, with \`Blocked\` /
  \`Canceled\` as side states.
- Reports: \`Active\` / \`Backlog\`.

**Never resolve an issue unprompted.** A transition to \`Done\` or \`Canceled\`
(and a report to \`Backlog\`) removes it from the active lens — those are the
user's call. Advance up to \`In Review\` on your own when reality warrants;
closing one out waits for the user to ask.

## Markdown style

Write plain CommonMark; the app's editor serializes with fixed remark
defaults — match them to keep diffs quiet.

Anything that asks the user to verify by hand — acceptance points, "✋ 手工
验收" lists, "待你测试" notes — must be written as GFM task checkboxes
(\`- [ ] …\`), one per discrete check, never as prose or plain bullets. This
keeps every open verification trackable and impossible to overlook.
`;

/**
 * Frozen prior shipped constitution defaults. Used ONLY to recognize an
 * untouched factory constitution that predates the current template, so it
 * can be offered an upgrade (§5 项目提示词的自动升级). A project whose
 * `.iris/CONVENTIONS.md` matches none of these (nor the current template) has
 * been customized and is left alone.
 *
 * APPEND (never edit/remove) the outgoing CONSTITUTION_TEMPLATE here whenever
 * you change it. The entry below is the pre-治理 monolithic constitution that
 * still mixed folder semantics into the project layer.
 */
export const LEGACY_CONSTITUTION_DEFAULTS: readonly string[] = [
  `---
protocol: 1
---

# Iris Project Conventions

Every PM artifact is a markdown file inside a typed folder (\`status/\`,
\`issue/\`, \`report/\`, \`misc/\`) under \`.iris/\`. Typed folders may appear at
any depth: any folder containing typed folders is a **workspace**.

## Folder semantics

- \`status/\` — Current state of the codebase. **Keep in sync with
  reality.** Every status doc carries \`reflects: <git-commit-sha>\` in
  frontmatter, stamped with the HEAD it reflects.
- \`issue/\` — Things to do, bugs, open questions. Mark resolved by
  updating \`status:\` in frontmatter; do not delete.
- \`report/\` — Append-only snapshots and session journals. The body is
  append-only: never rewrite an existing report; add new files.
  Frontmatter is not: flipping \`status:\` between \`Active\` and
  \`Backlog\` is allowed.
- \`misc/\` — Human scratch space. Do not touch unless asked.

## Rules for you (the agent)

1. **Focus protocol.** If \`$FOCUS_DOC\` is set, \`cat\` it first; its path
   tells you both its type and its workspace. Then **wait for the user's
   instruction** — context loading is not a task.
2. **Write-back scope.** Write results into the **nearest workspace
   enclosing \`$FOCUS_DOC\`**. Do not create new workspaces unless asked.
3. **Stamping.** After changing anything a status doc tracks, regenerate
   that doc and restamp \`reflects:\` with current \`git HEAD\`.
4. **No unsolicited files.** Never create a new file — reports
   included — unless the user explicitly asks for one. Editing the doc
   \`$FOCUS_DOC\` points to is always allowed, and so are frontmatter
   updates (e.g. \`status:\` transitions) on existing docs.
5. **Naming.** New files in \`issue/\` and \`report/\` use a
   \`YYYY-MM-DD-<slug>.md\` prefix.
6. **Soft state machine** for the \`status:\` field — the stored value IS
   the displayed value, so write it exactly as shown (deviate only when
   reality demands). Issues: \`Todo\` → \`In Progress\` → \`In Review\` →
   \`Done\`, with \`Blocked\` / \`Canceled\` as side states. Reports:
   \`Active\` / \`Backlog\`. **Never resolve an issue unprompted.** A
   transition to \`Done\` or \`Canceled\` (and a report to \`Backlog\`)
   removes it from the active lens — those are the user's call. Advance up
   to \`In Review\` on your own when reality warrants; closing one out
   waits for the user to ask.
7. **After a git merge**, do not hand-merge status docs — regenerate and
   restamp them.
8. **Trust calibration.** Before relying on a status doc, compare its
   \`reflects:\` stamp to \`git HEAD\`. Large gap → treat as weak prior and
   verify against the code.
9. **Markdown style.** Write plain CommonMark; the app's editor
   serializes with fixed remark defaults — match them to keep diffs
   quiet.
10. **Off-limits.** Never modify this file. Never write outside typed
    folders. Never touch code directories unless explicitly asked.
`,
];

// ──────────────────────────────────────────────────────────────────
// AGENTS.md guidance — now the `<iris-software>` managed block.
// ──────────────────────────────────────────────────────────────────

/**
 * Marker used for idempotent detect/upsert of the Iris block in entry files.
 * Switched from the old `## Project management (Iris)` heading to the opening
 * tag: the block is now tag-delimited, so the tag IS the boundary.
 */
export const SOFTWARE_BLOCK_TAG = 'iris-software';
export const AGENTS_GUIDANCE_MARKER = `<${SOFTWARE_BLOCK_TAG}`;

/**
 * Well-known agent-specific entry files other tools read from the project
 * root. Iris standardizes on `AGENTS.md` and owns the `<iris-software>` block;
 * for these vendor entries it MAINTAINS the block in any that already exist
 * (it never creates a new vendor file — that would grow a zoo). `AGENTS.md` is
 * deliberately absent: it is the standard entry Iris owns and always writes.
 */
export const FOREIGN_AGENT_ENTRIES: readonly string[] = [
  'CLAUDE.md',
  'GEMINI.md',
  '.cursorrules',
  '.windsurfrules',
  '.clinerules',
  '.github/copilot-instructions.md',
];

// ──────────────────────────────────────────────────────────────────
// User layer — ~/.iris/CONVENTIONS.md (machine facts).
// ──────────────────────────────────────────────────────────────────

/** Appendix C — ~/.iris/CONVENTIONS.md (machine layer), with TODO blanks. */
export const MACHINE_CONVENTIONS_TEMPLATE = `# Machine Conventions (this machine only — not in git)

## Environment facts

State **facts**, not rules. Keep this file the shortest of the three.

<!-- 按本机实情删改下面的条目；不适用的整行删掉 -->

- Encryption: this machine runs <NAME> transparent file encryption.
  Files created outside whitelisted dirs (<DIRS>) get silently
  encrypted; corrupted-looking build artifacts are usually this, not
  your code. Workaround: <HOW>.
- Network: outbound traffic requires proxy \`http://127.0.0.1:<PORT>\`;
  npm/pip use mirrors <URLS>.
- Machine: corporate VM; snapshots nightly — \`/tmp\` does not persist.
- Resources: 8 GB RAM — do not run the full test suite in parallel.
- Permissions: no sudo on this box.
- Toolchain: node via nvm; system python locked at 3.9.

## Personal preferences (optional, keep short)

- Write issue/report documents in Chinese.
`;
