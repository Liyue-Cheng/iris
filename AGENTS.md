## Project management (Iris)

This project uses Iris (an AI-native PM tool). All PM documents live under
`.iris/` in typed folders: `status/`, `issue/`, `report/`, `misc/` —
possibly nested inside sub-workspaces.

Before doing work in this project:

1. Read `.iris/CONVENTIONS.md` for folder semantics and write-back rules.
2. If `~/.iris/CONVENTIONS.md` exists, read it for machine-specific facts
   (proxy, encryption software, VM constraints). Nearer scope wins on
   conflict.
3. Check the environment variable `$FOCUS_DOC`. If set, it points to the
   document the user is currently focused on (path relative to project
   root). Read it before acting.

Do not modify `.iris/CONVENTIONS.md` — it is the human-authored contract.
Do not create new files under `.iris/` unless the user explicitly asks;
editing the focused document is fine.
