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
import { ISSUE_STATUS, REPORT_STATUS } from '@shared/document-status';

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

## Document assets

Each Markdown document may have a sibling \`<name>.assets/\` directory. Files
inside that directory are internal document files and may be referenced with
ordinary relative Markdown links such as \`./<name>.assets/image.png\`.

The same directory may contain a \`links.txt\` file. Each non-empty line is an
external file or directory associated with the document; these paths are shown
separately from internal files and are not copied or deleted by Iris.

That is the complete asset model. Do not add hashes, manifests, registries,
deduplication, managed/unmanaged labels, orphan cleanup, adoption workflows,
or other asset governance. Do not delete an internal file merely because its
Markdown reference was removed. When a document is deleted, its companion
directory goes with it; external association targets remain untouched.

## What the app parses

Frontmatter keys are read literally — use exactly these (unknown keys are
ignored, and a misspelled key silently drops the field):

- \`title:\` — display title; falls back to the filename when absent.
- \`status:\` — drives the issue/report lenses and uses the state machine below.

The \`labels:\` frontmatter field is reserved and is not currently enabled.
Do not add, populate, edit, normalize, or remove it unless the user explicitly
asks to repair or migrate existing label metadata. Preserve an existing valid
\`labels:\` field verbatim.

A new issue starts as (a report starts with \`status: Active\`; a status doc
does not require a status field):

\`\`\`
---
title: <short title>
status: ${ISSUE_STATUS.todo}
---
\`\`\`

The stored \`status:\` value is also the displayed value; write canonical values
exactly as shown unless reality requires an exceptional value.

- Issues normally move from \`${ISSUE_STATUS.todo}\` to \`${ISSUE_STATUS.inProgress}\` and then
  \`${ISSUE_STATUS.inReview}\`. \`${ISSUE_STATUS.blocked}\`, \`${ISSUE_STATUS.onHold}\`,
  \`${ISSUE_STATUS.done}\`, and \`${ISSUE_STATUS.canceled}\` are also supported states.
- Reports: \`${REPORT_STATUS.active}\` / \`${REPORT_STATUS.backlog}\`.

Do not mark an issue \`Done\`, \`Canceled\`, or \`On Hold\` unless the user asks.
You may move an issue to \`In Review\` when the work is ready for review.

The app also collects every GFM task checkbox (\`- [ ] …\`) across \`.iris/\`
docs into a todo panel, where the user tracks open items and checks them
off. Anything that awaits someone's action — acceptance checks, things for
the user to verify or decide, follow-ups — must be written as task
checkboxes, one per discrete item, never as prose or plain bullets: a
pending item written as prose is invisible to the panel.

## How context reaches you

If Iris provides a focused document or workspace snapshot, use it as the
initial context. If no snapshot is provided and \`FOCUS_DOC\` is available, read
that document first. Do not reread unchanged injected context.

## Working rules (invariant)

1. **Focus protocol.** Use the provided focused document or workspace context.
   If none is provided and \`$FOCUS_DOC\` is set, read that document first.
   Loading context is not a task; wait for the user's instruction.
2. **Write-back scope.** Write results beside the focused document, within its
   existing \`.iris/\` workspace. Do not create a new workspace unless asked.
3. **No unsolicited Iris-managed files.** Do not create new \`.iris/\` documents
   or assets unless the user asks. For an explicitly requested implementation
   task, you may create the required source, test, and configuration files.
   You may edit the focused document and its frontmatter.
4. **Naming.** New files in \`issue/\` and \`report/\` use a \`YYYY-MM-DD-<slug>\`
   prefix.
5. **Off-limits.** Never modify the \`<iris-software>\` or \`<iris-project>\`
   blocks. Never write outside typed
   folders. Never touch code directories unless explicitly asked.

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
