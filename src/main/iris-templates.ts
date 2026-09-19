/**
 * @file src/main/iris-templates.ts
 * @purpose The protocol's canonical prose and optional context templates
 *   (issue: iris软件提示词治理):
 *
 *   - SOFTWARE_PROMPT_TEMPLATE — the invariant protocol mechanics. App-owned
 *     and injected as the `<iris-software>` managed block. Disk edits are
 *     reported as drift and never imported into this built-in source.
 *   Block parsing and synchronization live in software-prompt.ts.
 */
export const SOFTWARE_BLOCK_TAG = 'iris-software';
export const PROJECT_BLOCK_TAG = 'iris-project';

// ──────────────────────────────────────────────────────────────────
// Software layer — the `<iris-software>` managed-block body.
// ──────────────────────────────────────────────────────────────────

/**
 * The invariant protocol the agent must follow in ANY Iris project on ANY
 * machine. Injected verbatim inside `<iris-software>` in AGENTS.md and existing
 * vendor entry files. Optional project guidance lives beside it in an
 * `<iris-project>` block.
 */
export const SOFTWARE_PROMPT_TEMPLATE = `This project is managed with Iris — an AI-native, document-centric PM tool.
All PM artifacts are plain markdown files under \`.iris/\`, in typed folders.
The rules below are Iris's invariant protocol: they ship with the app and do
not vary per project. Optional user-authored project guidance lives in the
entry files' \`<iris-project>\` block.

## Folder semantics

Iris documents live in \`.iris/status/\`, \`.iris/issue/\`, \`.iris/report/\`, or
\`.iris/misc/\` folders. Work in the workspace containing the focused document.
Treat documents under \`report/\` as historical unless the user asks to change them.

- \`status/\` — Current state of the codebase — keep it in sync with reality.
- \`issue/\` — Things to do, bugs, and open questions. Preserve issue history by
  default and append updates; if the user explicitly asks to reorganize,
  rewrite, or remove content, follow that request. Mark resolved via \`status:\`;
  never delete the file without the user's request.
- \`report/\` — Dated analyses, reviews, and summaries. Edit or replace them as
  the user requests.
- \`misc/\` — Human scratch space. Do not touch unless asked.

Issue records may be incomplete or inaccurate; do not assume they were written
or maintained rigorously, and do not treat them as a source of truth. Workflow
statuses, including \`Done\`, do not establish that work was fully implemented
or verified.

## Workspace external paths

A workspace may contain an \`external.txt\` file at its root. Each non-empty,
non-comment line associates one external file or directory with that workspace.
Relative paths are resolved from the workspace directory; absolute paths remain
machine-specific. These entries are references only: do not move, modify, or
delete their targets unless the user explicitly asks.

\`external.txt\` is not a fifth document type and is not a PM write-back target.
Preserve comments, blank lines, unknown or unavailable paths, and existing line
order when editing it. Prefer portable relative paths for shared projects. A
workspace or document deletion never deletes an external target.

## Document assets

Each Markdown document may have a sibling \`<name>.assets/\` directory. Files
inside that directory are internal document files and may be referenced with
ordinary relative Markdown links such as \`./<name>.assets/image.png\`.

The same directory may contain a \`links.txt\` file. Each non-empty line is an
external file or directory associated with the document; these paths are shown
separately from internal files and are not copied or deleted by Iris.

Documents use this sibling-directory and optional \`links.txt\` model. Preserve
these files according to the document lifecycle described above. Do not delete an internal file merely because its Markdown reference was removed. When a
document is deleted, its companion directory goes with it; external association
targets remain untouched.

## Document fields and statuses

Iris documents support these frontmatter fields:

- \`title:\` — the document's display title; when absent, the filename is used.
- \`status:\` — the document's workflow status.

Issues use \`Todo\`, \`In Progress\`, \`In Review\`, \`Blocked\`, \`On Hold\`, \`Done\`, or
\`Canceled\`; new issues normally start at \`Todo\` and progress through
\`In Progress\` and \`In Review\`.

Reports, status documents, and misc documents use \`Active\` or \`Backlog\`; newly
created non-issue documents normally start at \`Active\`. Preserve canonical
status spelling when writing frontmatter.

The \`labels:\` frontmatter field is reserved. Preserve an existing \`labels:\` field verbatim. Do not change it unless the
user explicitly asks for label-related work.

Do not mark an issue \`Done\`, \`Canceled\`, or \`On Hold\` unless the user asks.
When work is requested for an existing issue, update its \`status:\` to \`In Progress\` before substantive investigation or edits, and keep it there while work is ongoing. When the requested work is complete and only human review, verification, or approval remains, update it to \`In Review\` and add one unchecked task per remaining item. Do not set \`Blocked\`, \`Done\`, \`Canceled\`, or \`On Hold\` on your own; make those transitions only when the user explicitly asks.

When an item requires human review, verification, approval, or follow-up,
represent it with one GFM task checkbox (\`- [ ] …\`) per discrete item rather
than only mentioning it in prose. Use prose for explanations and context.

## How context reaches you

Iris may provide context in an injected snapshot or through environment
variables set on the terminal process. \`FOCUS_DOC\` is the project-root-relative
path of the focused document in a document session. \`IRIS_WORKSPACE_PATH\` is
the project-root-relative path of the active Iris workspace in a workspace hub
session, where no document is focused.

Use an injected focused-document or workspace snapshot when one is present. If
no snapshot is present and \`FOCUS_DOC\` is set, read that file before proceeding.
If neither a snapshot nor \`FOCUS_DOC\` is present, use the user's task to
determine what to inspect. Do not reread injected context unless it may have
changed or the user asks for a fresh read.

## Working rules

1. **Context.** Follow the context priority described above. A missing focus
   does not prevent you from carrying out an explicit user task.
2. **Write-back scope.** When writing PM results, use the existing \`.iris/\` workspace that contains the focused document. Unless the user asks, do not create a new Iris workspace, PM document, or companion asset. Files required for an explicitly requested code change are allowed.
3. **Naming.** New files in \`issue/\` and \`report/\` use a
   \`YYYY-MM-DD-<slug>\` prefix.
4. **Protected content and paths.** Preserve the \`<iris-software>\` and
   \`<iris-project>\` blocks unless the user explicitly asks to edit prompt
   guidance. For PM write-backs, use the relevant typed \`.iris/\` folder. Code
   directory changes are allowed when they are part of the user's requested
   implementation or fix.
5. **Issue traceability.** When a task is driven by a focused issue, append the
   plan, implementation result, and relevant verification evidence to that
   issue. For a pure consultation, or when the user asks for a chat-only answer,
   keep the response in chat unless they request an issue update.
6. **Verification reporting.** When reporting results, distinguish completed
   changes, checks actually run, and remaining assumptions or unverified items.
   Do not present an inference as a verified fact.

Write standard Markdown and preserve the document's existing formatting where
practical. Follow the entry file's \`<iris-project>\` block when it contains
user guidance, unless it conflicts with this software protocol.`;

// ──────────────────────────────────────────────────────────────────
// AGENTS.md guidance — now the `<iris-software>` managed block.
// ──────────────────────────────────────────────────────────────────

/**
 * Marker used for idempotent detect/upsert of the Iris block in entry files.
 * Switched from the old `## Project management (Iris)` heading to the opening
 * tag: the block is now tag-delimited, so the tag IS the boundary.
 */
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
