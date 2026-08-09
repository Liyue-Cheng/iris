<p align="center">
  <img src="build/wordmark.svg" alt="Iris" width="220">
</p>

<p align="center">
  A local-first Agent Development Environment for human-agent software work.
</p>

Iris brings project documents, interactive agent terminals, Git state, and human attention into one desktop workspace. It does not embed a model or replace your agent CLI. Instead, it gives the tools you already use a durable project memory and a visible place to work together.

Your project state stays in ordinary Markdown under `.iris/`. Your agents run in real PTYs at the project root. Git remains the collaboration and delivery layer. There is no Iris account, cloud database, API key, or proprietary project format.

> Current release line: `0.1.0-beta`. Iris is Windows-first and currently ships for Windows x64.

<!--
README SCREENSHOT 1: Main workspace overview
Suggested file: docs/images/readme-overview.png
Show: lens tree on the left, an issue document in the middle, and an active Codex or Claude session on the right.
Suggested crop: 16:9, 1600x900 or larger.
Insert here as: ![Iris workspace](docs/images/readme-overview.png)
-->

## Why Iris

Agentic development changes the bottleneck. Producing code is faster, but the surrounding work is still fragmented:

- Context is repeatedly copied into short-lived chats and terminals.
- Progress is hidden inside several concurrent sessions.
- An agent waiting for input looks the same as one still working.
- Decisions and results often remain in conversation history instead of the project.
- Traditional project managers describe work but do not share state with local agents.

Iris treats those as one coordination problem. Documents are long-term memory. Terminal sessions are working memory. The filesystem is the contract between humans, agents, editors, and Git.

## The Design Bet

Iris assumes that as agents make code production cheaper, the scarce work moves elsewhere: expressing intent, preserving constraints, tracking unresolved questions, evaluating evidence, and continuously refining what the project knows about itself. Running more agents is useful, but execution throughput is not the highest-level problem if nobody can reliably recover why the work exists or decide whether the result is correct.

Most agent tools make the agent or its conversation the unit of continuity. Iris makes the project the unit of continuity instead. Agents are interchangeable execution resources, and terminal sessions are disposable contexts. A session may end, its context window may fill, or one agent CLI may be replaced by another without taking the project's memory with it. Anything worth keeping must be externalized as an issue, status, report, task, code change, test, or Git history rather than remaining trapped in a transcript.

This makes Iris an intent-oriented programming environment. Issues describe the gap between current reality and desired reality; disposable agent sessions interpret and act on that intent; code and tests provide implementation evidence; reports preserve dated findings; and status documents restate the current system after reality changes. The loop is durable even when every agent that participated in it is gone.

```text
intent and constraints -> disposable agent execution -> code and evidence
          ^                                               |
          `----- reports and current project state <------'
```

## The Core Workflow

1. Open a local project in Iris.
2. Initialize the Iris protocol, or use an existing `.iris/` tree.
3. Create or select an issue, status document, report, or workspace hub.
4. Launch Claude Code, Codex, Gemini, another CLI, or a plain shell from that context.
5. Give the agent an instruction. Iris has already supplied the document or workspace context when the configured CLI supports it.
6. Let the agent edit code and Markdown on disk.
7. Iris watches the files and re-projects the interface from the new disk state.
8. Review the result, update the issue, and commit through Git.

Launching a session is not dispatching a background job. The agent starts interactively and waits for you. You can leave, work elsewhere, and return when the session state indicates that it may need attention.

<!--
README SCREENSHOT 2: Document-to-agent workflow
Suggested file: docs/images/readme-focused-session.png
Show: one issue selected, its typed header and body, plus the right-pane launch menu or a focused agent session.
Suggested crop: 3:2, at least 1400px wide.
Insert here as: ![A document-focused agent session](docs/images/readme-focused-session.png)
-->

## Three Product Layers

Iris separates a portable protocol from its desktop implementation and its agent adapters.

### The `.iris/` protocol

The protocol is a filesystem convention plus agent guidance. It can be read and edited without the Iris application.

```text
my-project/
|-- AGENTS.md
|-- .iris/
|   |-- status/
|   |   `-- architecture.md
|   |-- issue/
|   |   |-- 2026-08-08-fix-auth.md
|   |   `-- 2026-08-08-fix-auth.assets/
|   |-- report/
|   |   `-- 2026-08-08-auth-review.md
|   |-- misc/
|   `-- spike-new-parser/
|       |-- status/
|       |-- issue/
|       `-- report/
`-- src/
```

Four folder names have built-in meaning wherever they appear inside `.iris/`:

| Folder | Time orientation | Purpose |
| --- | --- | --- |
| `status/` | Now | A current mirror of the codebase, stamped with the Git commit it reflects |
| `issue/` | Future and active work | Problems, tasks, decisions, and their working record |
| `report/` | Dated past | Reviews, analyses, summaries, and other deliverables |
| `misc/` | Outside the workflow | Human scratch space with no freshness contract |

The nearest typed folder decides a document's type. Any directory that directly contains a typed folder is inferred as a workspace. There is no workspace manifest or database.

Frontmatter keys are literal interfaces, while values remain flexible:

```markdown
---
title: Harden session replay
status: In Progress
---
```

Issue states default to `Todo`, `In Progress`, `In Review`, `Blocked`, `Done`, or `Canceled`. Reports use `Active` and `Backlog`. Iris preserves exceptional values instead of rejecting the document.

The `labels:` frontmatter field is reserved but not currently enabled. Iris
preserves valid legacy metadata, but the application and its managed agent
guidance do not create, edit, display, group, or filter by labels.

Every GFM task item in an active issue is also projected into the Todo panel:

```markdown
- [ ] Reproduce the failure in the packaged build
- [ ] Verify the fix with Codex and Claude Code
```

Checking a task in the panel writes back to that exact line in the source document.

### The desktop application

The Electron app is the reference implementation and operational control plane for the protocol. It provides:

- Recursive `.iris/` scanning and live filesystem projection
- Project initialization and inferred sub-workspaces
- Type-specific collection views
- WYSIWYG Markdown editing with a source-mode escape hatch
- Managed document assets
- Multiple interactive PTY sessions per document or workspace
- Git status, staging, unstaging, commits, and local branch switching
- Multiple project windows with isolated session and watcher state
- Machine-level themes, editor behavior, terminal behavior, and agent configuration

The protocol preserves portability. The app provides efficiency, safety, and concurrency control.

### Agent adapters

Iris runs agent commands that are already installed and authenticated on your machine. Default entries include Claude Code, Codex, Gemini, and a plain terminal; the list and command lines are editable.

A document session receives:

```text
FOCUS_DOC=.iris/issue/2026-08-08-fix-auth.md
```

A workspace hub session receives `IRIS_WORKSPACE_PATH` and deliberately has no focused document.

On Windows, Iris can install a generated SessionStart context script at `~/.iris/focus-context.ps1` and, after explicit confirmation, connect supported CLI hook configurations. The current hook adapter recognizes Claude Code, Codex CLI, Gemini CLI, Qwen Code, and Cursor CLI. CLIs without hook support can still read the environment pointer and project guidance directly.

Static project rules live in entry files such as `AGENTS.md`. Dynamic focus lives in the session environment. The two have different lifetimes and are intentionally kept separate.

## The Interface

### Left: work and attention

The lens tree groups documents by workspace and type. Active issues and reports remain prominent, while resolved work leaves the default lens. Session state dots show whether an anchored terminal is producing output, quiet and possibly waiting, or exited.

The left pane also provides project switching, recent projects, new windows, workspace creation, search, sorting, the Todo panel, and Git source control.

### Middle: documents and collections

Single-document views separate structured frontmatter from the Markdown body. The typed header owns title, status, save state, and assets. The body uses a Crepe/Milkdown WYSIWYG editor with GFM, LaTeX, syntax-highlighted code blocks, Mermaid previews, image upload, and a CodeMirror source mode.

Each document type has a different collection view:

- Issues support activity filters, search, workspace filters, grouping, sorting, keyboard navigation, multi-selection, and bulk state changes.
- Todo aggregates unchecked tasks from active issues.
- Status compares each document's `reflects` commit with the current Git HEAD.
- Reports are arranged as a dated timeline.
- Misc stays intentionally simple.

### Right: real terminals

The right pane is xterm.js connected to a real local PTY, not a chat transcript. A document or workspace may own multiple sessions. Terminals support search, clipboard integration, file drop, document drop, resize-aware geometry, and full-state replay when remounted.

Project and workspace hubs give the terminal the full work area. A selected document uses a resizable editor-and-terminal split. Collection views use the full area for management work.

<!--
README SCREENSHOT 3: Collection and attention views
Suggested file: docs/images/readme-issue-panel.png
Show: grouped Issue panel or Todo panel, including status, workspace, and counts.
Suggested crop: 16:9, 1600x900 or larger.
Insert here as: ![Issue management in Iris](docs/images/readme-issue-panel.png)
-->

## Files Are the Contract

Iris never interprets an agent's prose output to decide whether work is complete. It observes durable state instead:

- Agent edits arrive through filesystem events.
- The renderer rescans and projects the current disk state.
- Editor writes use compare-and-swap baselines so an external edit is not silently overwritten.
- Dirty drafts block view changes, Git actions, project switches, and application close until they are saved or resolved.
- Project operations carry a canonical root and generation so late events from an old project cannot affect the new one.
- Discrete mutations are serialized by resource through the FrontCPU instruction pipeline.

This is what makes plain files viable with several simultaneous writers.

## Sessions as Working Memory

Sessions are anchored when created. One document can have several sessions, while root and nested workspaces can have unfocused hub sessions. Iris does not continuously retarget a running agent.

The main process owns the PTY pool. A headless xterm mirror tracks the complete terminal state, including alternate-screen TUIs. When a renderer remounts a terminal, Iris serializes that state and then resumes live output without double-writing the replay boundary.

Sessions survive renderer reloads and interface switches while the owning window remains open. They are intentionally not durable across application exit, window close, or project replacement. Documents are long-term memory; sessions are disposable working memory.

## Document Assets

A document may own a sibling companion directory:

```text
2026-08-08-auth-review.md
2026-08-08-auth-review.assets/
```

Imports use content hashes for stable, portable names. The asset panel derives four health states from Markdown references and disk contents: referenced, orphan, missing, and unmanaged. It can adopt legacy local images or data URLs, copy Markdown links, reveal files, and move unreferenced managed assets to the system trash.

Iris does not automatically download remote assets or delete orphans. Deleting a document moves the Markdown file and its companion directory to the system trash as one aggregate.

## Git Integration

The built-in Git view is deliberately small and local:

- Repository status and branch information
- Merge, staged, working-tree, and untracked groups
- Stage and unstage selected paths
- Commit staged changes
- Switch local branches
- Ahead and behind indicators when Git provides them

Iris currently does not provide diff editing, fetch, pull, push, remote account integration, or a merge-conflict editor. Use your existing Git tools for those operations.

## Install

### System requirements

- Windows 10 or Windows 11, x64
- Git available on `PATH` for source control features
- At least one agent CLI installed and authenticated, or use the plain terminal
- PowerShell for the current zero-turn SessionStart hook adapter

### Release builds

Pre-release builds are published on the [GitHub Releases](https://github.com/Liyue-Cheng/iris/releases) page in two forms:

- `Iris-<version>-setup.exe`: per-user installer with Start menu and optional desktop shortcuts
- `Iris-<version>-portable.exe`: single-file portable build

Iris is not currently code-signed. Windows SmartScreen may display an unrecognized publisher warning. Verify that the file came from this repository's GitHub Releases page before running it.

The installer and portable build share machine-level settings under `~/.iris/`. Uninstalling the application does not delete those settings or any project `.iris/` data.

## Quick Start

1. Launch Iris and choose **Open Project Folder**.
2. If the project has no `.iris/`, review and confirm **Initialize Iris Protocol**.
3. Open **Settings > Agents** and configure the CLI commands you use.
4. Optionally install the SessionStart hook for zero-turn focus injection.
5. Create an issue or select an existing document in the lens tree.
6. Use the right-pane launcher to open an agent under that document.
7. Give the agent a concrete instruction and review its changes on disk and in Git.

Initialization creates the four typed directories and adds or refreshes an Iris-owned `<iris-software>` block in `AGENTS.md`. Existing vendor entry files such as `CLAUDE.md` are synchronized only when they already exist; Iris does not create a collection of vendor files. An optional `<iris-project>` block can hold project-specific guidance and is synchronized across existing entry files.

<!--
README SCREENSHOT 4: Agent and prompt settings
Suggested file: docs/images/readme-agent-settings.png
Show: configured agent commands and context-injection state.
Suggested crop: 16:9 or 3:2, at least 1400px wide.
Insert here as: ![Agent configuration and context injection](docs/images/readme-agent-settings.png)
-->

## What Iris Does Not Do

These are current product boundaries, not hidden roadmap promises:

- No embedded model, model SDK, API key, or model subscription
- No account, cloud database, hosted sync, permission system, or telemetry
- No headless agent dispatch or autonomous orchestration queue
- No parsing of agent terminal output as business state
- No built-in code editor
- No persistent PTY sessions after the owning window closes
- No custom document types in the current protocol
- No complete Git client
- No full POSIX context-injection adapter yet

Iris coordinates local tools instead of replacing them.

## Development

### Prerequisites

- Node.js 20 or newer
- npm
- Windows build environment capable of running Electron and the bundled `node-pty` prebuild

`front-cpu` is installed from the npm registry, so a clean checkout does not require a sibling repository.

### Commands

```powershell
npm install
npm run dev
```

Quality checks:

```powershell
npm test -- --run
npm run typecheck
npm run build
npm run licenses:check
```

Create Windows x64 installer and portable artifacts:

```powershell
npm run dist
```

Artifacts are written to:

```text
dist/release/<version>/
```

`npm run dist` refuses to package a stale third-party notice file. After changing dependencies, run `npm run licenses:generate` and review the generated diff.

The development build uses separate app data and a separate Electron single-instance profile, so it can run alongside an installed build without sharing settings or locks.

## Architecture

```text
src/main/       Electron lifecycle, project scanning, file watchers, PTYs,
                assets, Git, persistence, prompt governance, IPC
src/preload/    Narrow context-isolated renderer bridge
src/renderer/   React interface, projection stores, editors, terminal view,
                FrontCPU instruction definitions and interrupts
src/shared/     Cross-process models, IPC channel names, Markdown utilities,
                status definitions, terminal keybindings
```

The main process is authoritative for project scope, disk access, PTY lifetime, and Git operations. The renderer keeps read-side projections and sends mutations through the instruction pipeline. Continuous terminal I/O bypasses that pipeline to avoid per-keystroke scheduling overhead.

Key technologies include Electron, TypeScript, React 18, Tailwind CSS, Radix UI, Milkdown/Crepe, CodeMirror 6, node-pty, xterm.js, chokidar, gray-matter, remark, Mermaid, Vitest, and FrontCPU.

## Current Status

Iris is beta software being developed through daily dogfooding on its own repository. The most mature areas are the filesystem protocol, document editing consistency, project scoping, and terminal state recovery. The current release target is a trustworthy Windows beta for technical users already comfortable with local agent CLIs and Git.

Bug reports and focused design discussions are welcome through [GitHub Issues](https://github.com/Liyue-Cheng/iris/issues).

## Data and Privacy

- Project artifacts remain in the project repository as ordinary files.
- Machine settings are stored locally under `~/.iris/` (`~/.iris-dev/` for development builds).
- Agent authentication and billing remain with each agent CLI.
- Iris does not send telemetry.
- External links open in the system browser only for allowed web and mail protocols.
- Local document and asset reads are constrained to the active project boundary.

Review agent-generated changes with the same care you would use in a standalone terminal. Iris improves context and visibility; it does not sandbox the commands your local agents can run.

## License

Iris is released under the [MIT License](LICENSE). Windows distributions also include the generated [third-party software notices](THIRD_PARTY_NOTICES.txt), Electron's license, and Chromium's notices.
