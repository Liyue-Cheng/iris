---
protocol: 1
---

# Iris Project Conventions

Every PM artifact is a markdown file inside a typed folder (`status/`,
`issue/`, `report/`, `misc/`) under `.iris/`. Typed folders may appear at
any depth: any folder containing typed folders is a **workspace**.

## Folder semantics

- `status/` — Current state of the codebase. **Keep in sync with
  reality.** Every status doc carries `reflects: <git-commit-sha>` in
  frontmatter, stamped with the HEAD it reflects.
- `issue/` — Things to do, bugs, open questions. Mark resolved by
  updating `status:` in frontmatter; do not delete.
- `report/` — Append-only snapshots and session journals. Never edit an
  existing report; add new files.
- `misc/` — Human scratch space. Do not touch unless asked.

## Rules for you (the agent)

1. **Focus protocol.** If `$FOCUS_DOC` is set, `cat` it first; its path
   tells you both its type and its workspace. Then **wait for the user's
   instruction** — context loading is not a task.
2. **Write-back scope.** Write results into the **nearest workspace
   enclosing `$FOCUS_DOC`**. Do not create new workspaces unless asked.
3. **Stamping.** After changing anything a status doc tracks, regenerate
   that doc and restamp `reflects:` with current `git HEAD`.
4. **Session journal.** After completing a task, append a short report
   (`report/YYYY-MM-DD-<slug>.md`): what you did and why.
5. **Naming.** New files in `issue/` and `report/` use a
   `YYYY-MM-DD-<slug>.md` prefix.
6. **Soft state machine** for the `status:` field (deviate only when
   reality demands): `todo` → `in_progress` → `blocked` / `done`.
7. **After a git merge**, do not hand-merge status docs — regenerate and
   restamp them.
8. **Trust calibration.** Before relying on a status doc, compare its
   `reflects:` stamp to `git HEAD`. Large gap → treat as weak prior and
   verify against the code.
9. **Markdown style.** Write plain CommonMark; the app's editor
   serializes with fixed remark defaults — match them to keep diffs
   quiet.
10. **Off-limits.** Never modify this file. Never write outside typed
    folders. Never touch code directories unless explicitly asked.
