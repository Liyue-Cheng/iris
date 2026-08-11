<iris-software>
This project is managed with Iris — an AI-native, document-centric PM tool.
All PM artifacts are plain markdown files under `.iris/`, in typed folders.
The rules below are Iris's invariant protocol: they ship with the app and do
not vary per project. Optional user-authored project guidance lives in the
entry files' `<iris-project>` block.

## Folder semantics

Typed folders — `status/`, `issue/`, `report/`, `misc/` — may appear at any
depth. Any folder containing typed folders is a **workspace**; a document's
type is decided by the nearest enclosing typed folder.

- `status/` — Current state of the codebase — a mirror, not a record: rewrite
  freely, keep in sync with reality. Every status doc carries
  `reflects: <git-commit-sha>` in frontmatter.
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

Managed assets live beside their owner document in a companion directory:
`<name>.md` owns `<name>.assets/`. Use standard relative Markdown links such
as `./<name>.assets/image--<hash>.png`; do not add an assets manifest or
frontmatter registry. Asset directories are opaque to document/workspace
scanning.

- Keep each asset owned by one document; copy it when another document needs
  an independent copy instead of linking across companion directories.
- Name imported files `<sanitized-name>--<sha256-prefix>.<ext>`. Treat a
  referenced asset as immutable: write a new file and update the link rather
  than overwriting bytes in place.
- Do not persist `blob:`, absolute filesystem paths, or new `data:` URLs.
  Existing project-relative and HTTPS references remain compatible but are
  unmanaged until explicitly imported.
- Never delete an asset merely because its reference disappeared. It becomes
  an orphan and awaits explicit human cleanup. When a document is moved,
  copied, renamed, or human-deleted, handle its companion directory with it.

## What the app parses

Frontmatter keys are read literally — use exactly these (unknown keys are
ignored, and a misspelled key silently drops the field):

- `title:` — display title; falls back to the filename when absent.
- `status:` — drives the issue/report lenses and uses the state machine below.
- `reflects:` — status docs only: the git commit sha the doc reflects.

The `labels:` frontmatter field is reserved and is not currently enabled.
Do not add, populate, edit, normalize, or remove it unless the user explicitly
asks to repair or migrate existing label metadata. Preserve an existing valid
`labels:` field verbatim.

A new issue starts as (a report starts with `status: Active`; a status doc
carries `reflects:` instead of `status:`):

```
---
title: <short title>
status: Todo
---
```

The stored `status:` value is also the displayed value; write canonical values
exactly as shown unless reality requires an exceptional value.

- Issues: `Todo` -> `In Progress` -> `In Review` -> `Done`, with
  `Blocked` as an active side state, `On Hold` as an inactive but unresolved
  state, and `Canceled` as a terminal side state.
- Reports: `Active` / `Backlog`.

Never make an issue inactive unprompted. A transition to `On Hold`, `Done`,
or `Canceled` (and a report to `Backlog`) removes it from the active lens
and may close attached terminal sessions; those transitions are the user's
call. `On Hold` remains unresolved and can return to `Todo`; only `Done`
and `Canceled` are resolved. Advance up to `In Review` on your own when
reality warrants.

The app also collects every GFM task checkbox (`- [ ] …`) across `.iris/`
docs into a todo panel, where the user tracks open items and checks them
off. Anything that awaits someone's action — acceptance checks, things for
the user to verify or decide, follow-ups — must be written as task
checkboxes, one per discrete item, never as prose or plain bullets: a
pending item written as prose is invisible to the panel.

## How context reaches you

The static software and optional project prompts are read from this entry file.
Iris also spawns terminals with `FOCUS_DOC` set to the focused document path.
For agents with a SessionStart hook it injects only dynamic context:

- `<iris-workspace>` — hub-session workspace metadata when there is no focus.
- `<iris-focus>` — a snapshot of `$FOCUS_DOC`.

**The session environment variables and reading the focus from disk are a
FALLBACK.** If you already received a dynamic snapshot via an injected
`<iris-…>` block, do not re-read it from disk unless you have reason to believe
it changed. Agents without a hook fall back to the environment variables.

## Working rules (invariant)

1. **Focus protocol.** If `$FOCUS_DOC` is set, read it first; its path tells you
   both its type and its workspace. Then wait for the user's instruction —
   loading context is not a task.
2. **Write-back scope.** Write results into the nearest workspace enclosing
   `$FOCUS_DOC`. Do not create new workspaces unless asked.
3. **Stamping.** Status docs do not update themselves. Before ending any
   work that changed the codebase, list the write-back workspace's
   `status/` docs, update those your changes falsified, and restamp their
   `reflects:` with current `git HEAD` — the change is not done until the
   mirror is true again. After a git merge, do not hand-merge status docs —
   regenerate and restamp.
4. **No unsolicited files.** Never create a new file — reports included —
   unless the user explicitly asks. Editing the focused document is always
   fine, as are frontmatter updates (e.g. `status:` transitions) on existing
   docs.
5. **Naming.** New files in `issue/` and `report/` use a `YYYY-MM-DD-<slug>`
   prefix.
6. **Trust calibration.** Before relying on a status doc, compare its
   `reflects:` stamp to `git HEAD`; a large gap means treat it as a weak prior
   and verify against the code.
7. **Off-limits.** Never modify the `<iris-software>` or `<iris-project>`
   blocks. Never write outside typed
   folders. Never touch code directories unless explicitly asked.

Write plain CommonMark. Iris's editor serializes with fixed remark defaults;
match them to keep diffs quiet. Follow the entry file's `<iris-project>` block
when it contains user guidance, unless it conflicts with this software
protocol.
</iris-software>

<iris-project>
围绕一个issue工作的时候，详细方案设计、结果应该默认写回issue，而不是打在控制台
面对“给我一个方案”类的指令，给出方案即可，不要立刻开始改代码
</iris-project>
