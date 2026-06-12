/**
 * @file src/main/iris-templates.ts
 * @purpose The protocol's canonical prose — verbatim from the definition
 *   doc's appendices. The constitution template IS the de-facto protocol
 *   spec (协议的事实规范就是宪法模板): edits here change what every agent
 *   reads, so treat wording changes as protocol changes.
 */

/** Current protocol version written into fresh constitutions. */
export const PROTOCOL_VERSION = 1;

/** Appendix B — .iris/CONVENTIONS.md (project constitution). */
export const CONSTITUTION_TEMPLATE = `---
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
- \`report/\` — Append-only snapshots and session journals. Never edit an
  existing report; add new files.
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
6. **Soft state machine** for the \`status:\` field (deviate only when
   reality demands): \`todo\` → \`in_progress\` → \`blocked\` / \`done\`.
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
`;

/** Marker line used for idempotent AGENTS.md appends. */
export const AGENTS_GUIDANCE_MARKER = '## Project management (Iris)';

/** Appendix A — the guidance section appended to the project's AGENTS.md. */
export const AGENTS_GUIDANCE = `${AGENTS_GUIDANCE_MARKER}

This project uses Iris (an AI-native PM tool). All PM documents live under
\`.iris/\` in typed folders: \`status/\`, \`issue/\`, \`report/\`, \`misc/\` —
possibly nested inside sub-workspaces.

Before doing work in this project:

1. Read \`.iris/CONVENTIONS.md\` for folder semantics and write-back rules.
2. If \`~/.iris/CONVENTIONS.md\` exists, read it for machine-specific facts
   (proxy, encryption software, VM constraints). Nearer scope wins on
   conflict.
3. Check the environment variable \`$FOCUS_DOC\`. If set, it points to the
   document the user is currently focused on (path relative to project
   root). Read it before acting.

Do not modify \`.iris/CONVENTIONS.md\` — it is the human-authored contract.
Do not create new files under \`.iris/\` unless the user explicitly asks;
editing the focused document is fine.
`;

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
