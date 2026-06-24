---
protocol: 1
---

# Iris Project Conventions

This file is the **project layer**: policy that may differ per project. The
invariant protocol (folder semantics, focus protocol, write-back scope) is
owned by Iris and injected separately as the `<iris-software>` block — you do
not need to restate it here. Keep this file short.

## State machine (`status:` field)

The stored value IS the displayed value — write it exactly as shown (deviate
only when reality demands).

- Issues: `Todo` → `In Progress` → `In Review` → `Done`, with `Blocked` /
  `Canceled` as side states.
- Reports: `Active` / `Backlog`.

**Never resolve an issue unprompted.** A transition to `Done` or `Canceled`
(and a report to `Backlog`) removes it from the active lens — those are the
user's call. Advance up to `In Review` on your own when reality warrants;
closing one out waits for the user to ask.

## Markdown style

Write plain CommonMark; the app's editor serializes with fixed remark
defaults — match them to keep diffs quiet.

Anything that asks the user to verify by hand — acceptance points, "✋ 手工
验收" lists, "待你测试" notes — must be written as GFM task checkboxes
(`- [ ] …`), one per discrete check, never as prose or plain bullets. This
keeps every open verification trackable and impossible to overlook.
