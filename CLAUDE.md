<iris-software>
This project is managed with Iris — an AI-native, document-centric PM tool.
All PM artifacts are plain markdown files under `.iris/`, in typed folders.
The rules below are Iris's invariant protocol: they ship with the app and do
not vary per project. Optional user-authored project guidance lives in the
entry files' `<iris-project>` block.

## Folder semantics

Iris documents live in `.iris/status/`, `.iris/issue/`, `.iris/report/`, or
`.iris/misc/` folders. Work in the workspace containing the focused document.
Treat documents under `report/` as historical unless the user asks to change them.

- `status/` — Current state of the codebase — a mirror, not a record: rewrite
  freely, keep in sync with reality.
- `issue/` — Things to do, bugs, open questions — the working record of a
  problem. Treat the body as a record: prefer appending updates; do not
  rewrite or delete existing content unprompted (frontmatter transitions and
  checkbox flips are always fine). Mark resolved via `status:`; never delete
  the file.
- `report/` — Dated deliverables: analyses, reviews, summaries. Edit freely
  while a report is fresh; once reality has moved on, prefer a new dated
  report over reshaping an old one.
- `misc/` — Human scratch space. Do not touch unless asked.

## Document assets

Each Markdown document may have a sibling `<name>.assets/` directory. Files
inside it are internal document files and may be referenced with ordinary
relative Markdown links such as `./<name>.assets/image.png`.

The directory may also contain `links.txt`. Each non-empty line is an external
file or directory associated with the document. External associations are
shown separately and are never copied or deleted by Iris.

This is the complete asset model: no hashes, manifests, registries,
deduplication, managed/unmanaged labels, orphan cleanup, or adoption workflow.
Removing a Markdown reference does not delete an internal file. Deleting a
document deletes its companion directory as a unit; external association
targets remain untouched.

## What the app parses

Frontmatter keys are read literally — use exactly these (unknown keys are
ignored, and a misspelled key silently drops the field):

- `title:` — display title; falls back to the filename when absent.
- `status:` — drives the issue/report lenses and uses the state machine below.

The `labels:` frontmatter field is reserved and is not currently enabled.
Do not add, populate, edit, normalize, or remove it unless the user explicitly
asks to repair or migrate existing label metadata. Preserve an existing valid
`labels:` field verbatim.

A new issue starts as (a report starts with `status: Active`; a status doc
does not require a status field):

```
---
title: <short title>
status: Todo
---
```

The stored `status:` value is also the displayed value; write canonical values
exactly as shown unless reality requires an exceptional value.

- Issues normally move from `Todo` to `In Progress` and then `In Review`.
  `Blocked`, `On Hold`, `Done`, and `Canceled` are also supported states.
- Reports: `Active` / `Backlog`.

Do not mark an issue `Done`, `Canceled`, or `On Hold` unless the user asks.
You may move an issue to `In Review` when the work is ready for review.

The app also collects every GFM task checkbox (`- [ ] …`) across `.iris/`
docs into a todo panel, where the user tracks open items and checks them
off. Anything that awaits someone's action — acceptance checks, things for
the user to verify or decide, follow-ups — must be written as task
checkboxes, one per discrete item, never as prose or plain bullets: a
pending item written as prose is invisible to the panel.

## How context reaches you

If Iris provides a focused document or workspace snapshot, use it as the
initial context. If no snapshot is provided and `FOCUS_DOC` is available, read
that document first. Do not reread unchanged injected context.

## Working rules (invariant)

1. **Focus protocol.** Use the provided focused document or workspace context.
   If none is provided and `$FOCUS_DOC` is set, read that document first.
   Loading context is not a task; wait for the user's instruction.
2. **Write-back scope.** Write results beside the focused document, within its
   existing `.iris/` workspace. Do not create a new workspace unless asked.
3. **No unsolicited Iris-managed files.** Do not create new `.iris/` documents
   or assets unless the user asks. For an explicitly requested implementation
   task, you may create the required source, test, and configuration files.
   You may edit the focused document and its frontmatter.
4. **Naming.** New files in `issue/` and `report/` use a `YYYY-MM-DD-<slug>`
   prefix.
5. **Off-limits.** Never modify the `<iris-software>` or `<iris-project>`
   blocks. Never write outside typed
   folders. Never touch code directories unless explicitly asked.

Write standard Markdown and preserve the document's existing formatting where
practical. Follow the entry file's `<iris-project>` block when it contains
user guidance, unless it conflicts with this software protocol.
</iris-software>

<iris-project>
围绕一个issue工作的时候，详细方案设计、结果应该默认写回issue，而不是打在控制台
面对“给我一个方案”类的指令，给出方案即可，不要立刻开始改代码
除非有明确要求，不要为了测试运行 npm run dist npm run build之类的打包命令
不要运行开发服务器截图来代替手工测试
</iris-project>
