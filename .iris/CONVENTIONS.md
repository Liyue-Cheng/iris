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
- `report/` — Append-only snapshots and session journals. The body is
  append-only: never rewrite an existing report; add new files.
  Frontmatter is not: flipping `status:` between `Active` and
  `Backlog` is allowed.
- `misc/` — Human scratch space. Do not touch unless asked.

## Rules for you (the agent)

1. **Focus protocol.** If `$FOCUS_DOC` is set, `cat` it first; its path
   tells you both its type and its workspace. Then **wait for the user's
   instruction** — context loading is not a task.
2. **Write-back scope.** Write results into the **nearest workspace
   enclosing `$FOCUS_DOC`**. Do not create new workspaces unless asked.
3. **Stamping.** After changing anything a status doc tracks, regenerate
   that doc and restamp `reflects:` with current `git HEAD`.
4. **No unsolicited files.** Never create a new file — reports
   included — unless the user explicitly asks for one. Editing the doc
   `$FOCUS_DOC` points to is always allowed, and so are frontmatter
   updates (e.g. `status:` transitions) on existing docs.
5. **Naming.** New files in `issue/` and `report/` use a
   `YYYY-MM-DD-<slug>.md` prefix.
6. **Soft state machine** for the `status:` field — the stored value IS
   the displayed value, so write it exactly as shown (deviate only when
   reality demands). Issues: `Todo` → `In Progress` → `In Review` →
   `Done`, with `Blocked` / `Canceled` as side states. Reports:
   `Active` / `Backlog`. **Never resolve an issue unprompted.** A
   transition to `Done` or `Canceled` (and a report to `Backlog`)
   removes it from the active lens — those are the user's call. Advance up
   to `In Review` on your own when reality warrants; closing one out
   waits for the user to ask.
7. **After a git merge**, do not hand-merge status docs — regenerate and
   restamp them.
8. **Trust calibration.** Before relying on a status doc, compare its
   `reflects:` stamp to `git HEAD`. Large gap → treat as weak prior and
   verify against the code.
9. **Markdown style.** Write plain CommonMark; the app's editor
   serializes with fixed remark defaults — match them to keep diffs
   quiet.
10. **Manual-test items are checkboxes.** Anything that asks the user to
    verify by hand — acceptance points, "✋ 手工验收" lists, "待你测试"
    notes — must be written as GFM task checkboxes (`- [ ] …`), one per
    discrete check, never as prose or plain bullets. This keeps every
    open verification trackable and impossible to overlook.
11. **Off-limits.** Never modify this file. Never write outside typed
    folders. Never touch code directories unless explicitly asked.
