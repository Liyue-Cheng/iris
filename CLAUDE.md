# CLAUDE.md

> 本项目用 Iris 管理自身（M3 起 dogfood）。PM 协议（文件夹语义、focus 协议、
> 写回作用域）由文末的 `<iris-software version="0.0.2-alpha.2" protocol="1" sha="787bcd6a3a44">
This project is managed with Iris — an AI-native, document-centric PM tool.
All PM artifacts are plain markdown files under `.iris/`, in typed folders.
The rules below are Iris's invariant protocol: they ship with the app and do
not vary per project. Project-specific policy lives in `.iris/CONVENTIONS.md`;
machine-specific facts live in `~/.iris/CONVENTIONS.md`.

## Folder semantics

Typed folders — `status/`, `issue/`, `report/`, `misc/` — may appear at any
depth. Any folder containing typed folders is a **workspace**; a document's
type is decided by the nearest enclosing typed folder.

- `status/` — Current state of the codebase; keep in sync with reality. Every
  status doc carries `reflects: <git-commit-sha>` in frontmatter.
- `issue/` — Things to do, bugs, open questions. Mark resolved via `status:`;
  do not delete.
- `report/` — Append-only snapshots and journals: never rewrite an existing
  report, add new files. Frontmatter may still change.
- `misc/` — Human scratch space. Do not touch unless asked.

## How context reaches you

Iris spawns your terminal with the environment variable `FOCUS_DOC` set to the
document the user is focused on (path relative to project root), and — for
agents with a SessionStart hook — injects a snapshot of the relevant files
directly, each wrapped in an `<iris-…>` tag:

- `<iris-software>` — this block (Iris protocol; app-owned, versioned).
- `<iris-project>` — `.iris/CONVENTIONS.md` (project policy).
- `<iris-user>` — `~/.iris/CONVENTIONS.md` (machine facts, if present).
- `<iris-focus>` — a snapshot of `$FOCUS_DOC`.

**The `FOCUS_DOC` env-var and reading these files from disk are a FALLBACK.**
If you already received a file's contents via the injected `<iris-…>` blocks
above, do not re-read it from disk — unless you have reason to believe it
changed (the injection is a snapshot taken at session start; the file may be
edited during the session, including by you). Agents without a hook fall back
to reading `$FOCUS_DOC` and the referenced files themselves.

## Working rules (invariant)

1. **Focus protocol.** If `$FOCUS_DOC` is set, read it first; its path tells you
   both its type and its workspace. Then wait for the user's instruction —
   loading context is not a task.
2. **Write-back scope.** Write results into the nearest workspace enclosing
   `$FOCUS_DOC`. Do not create new workspaces unless asked.
3. **Stamping.** After changing anything a status doc tracks, regenerate that
   doc and restamp `reflects:` with current `git HEAD`. After a git merge, do
   not hand-merge status docs — regenerate and restamp.
4. **No unsolicited files.** Never create a new file — reports included —
   unless the user explicitly asks. Editing the focused document is always
   fine, as are frontmatter updates (e.g. `status:` transitions) on existing
   docs.
5. **Naming.** New files in `issue/` and `report/` use a `YYYY-MM-DD-<slug>`
   prefix.
6. **Trust calibration.** Before relying on a status doc, compare its
   `reflects:` stamp to `git HEAD`; a large gap means treat it as a weak prior
   and verify against the code.
7. **Off-limits.** Never modify `.iris/CONVENTIONS.md` (the human-authored
   contract) or this `<iris-software>` block. Never write outside typed
   folders. Never touch code directories unless explicitly asked.

For project-specific policy — the issue/report state-machine values and the
markdown style to write in — read `.iris/CONVENTIONS.md`.
</iris-software>
