# Iris

> An AI-native, document-centric, terminal-driven project manager.
> It doesn't replace Jira — it replaces VS Code as the layer you live in when you're *not* looking at code.

Iris is a deliberately thin shell wrapped around two things you already have: **a pile of markdown files** and **a pool of terminal sessions**. It outsources all intelligence to the agent CLIs you've already installed and logged in to (`claude`, `codex`, `gemini`, `aider`, …), and keeps all of your data as plain text on disk. Open source, no account, no subscription, agent-agnostic.

In the AI era, programming *is* project management: you don't need to stare at code all the time, and when you do, the code editor is right there. Iris is the coordinating skin for everything that happens when you're not in the editor.

---

## Protocol first

**Iris is a protocol, not an app.** The protocol is a directory convention (`.iris/`) plus a short prose constitution — and it works without the app present: hand-make the folders, drop in the constitution, point a bare terminal at it, and you're running. The application is just the protocol's *reference implementation*: a **viewer** and a **summoner**.

That means everything below works whether or not you ever launch the GUI. The app makes the protocol pleasant; it does not make it *real*. Delete `.iris/` and your project is untouched — that's roughly equivalent to uninstalling Iris.

---

## Two first-class citizens

Everything in Iris orbits **documents** (markdown) and **terminals** (PTY). The rest of the design follows from keeping those two central.

### The filesystem is the database

All project data lives as `.md` files in folders. No proprietary format, no database, no cloud. **git** is your version control, your sync, and your collaboration layer. Data outlives software.

### Hard keys, soft values

All project configuration lives as *prose* (written in the constitution file), not as code.

- **Keys are hard** — the rendering layer parses them literally (`status:` present → task view; folder named `issue/` → issue type).
- **Values are soft** — agents fill them per a loose convention and are allowed to deviate.

Names are hard; tree shape is free.

### Types as lenses, not schemas

Types are navigation lenses, not enforced validation. There is **no schema validation, no manifest, no registry** — structure is inferred entirely from the filesystem (the name is the type; the workspace is inferred). Constraints live in the convention layer, not in the type system. The constitution is kept deliberately short, because every extra rule lowers the compliance rate of *all* rules (context rot).

### Dumb shell, outsourced intelligence

The app itself is nearly zero-intelligence. There is **no embedded agent, no SDK, no API key**. Intelligence comes from the CLI you already run on your own machine, on your own billing. (This doesn't forbid *your* BYOK automations — the shell carries no intelligence of its own, but it won't reject the intelligence you bring.)

### Agent-agnostic — files are the contract

Any agent that speaks through a CLI works. Iris **never parses an agent's terminal output**; it watches files instead. **Files are the contract.** Adding support for a new agent therefore needs almost no adapter code.

### Optional at every layer

Close the app and the folders are still usable plain text. Forget to inject `$FOCUS_DOC` and a human can just say one sentence. Forget the constitution and a doc lands in the wrong folder, nothing more. Drop the protocol entirely and `rm -rf .iris/` leaves the project whole.

---

## The protocol: data model

### Project structure

```
my-project/
├── AGENTS.md                 # Standard project entry (NOT owned by Iris). One appended guidance section.
├── .iris/                    # Iris's project-level namespace (the root workspace)
│   ├── CONVENTIONS.md        # The constitution. Hand-written once. App reads it; agents must not touch it.
│   ├── status/               # Current truth. Maintained live by the AI. Carries a commit stamp.
│   ├── issue/                # Things to do and known problems.
│   ├── report/               # One-shot snapshots; append-only archive.
│   ├── misc/                 # Human scratch space. Outside the system.
│   └── spike-auth/           # ← a sub-workspace (any name; contains typed folders)
│       ├── status/
│       ├── issue/
│       └── report/
└── (your code and everything else)
```

### One recursive rule: the name is the type

The protocol's load-bearing rule, applied recursively: **a folder named `status/`, `issue/`, `report/`, or `misc/` — at any depth in the `.iris/` tree — is parsed, rendered, and classified as that type.** Each markdown file's type is decided by its *nearest* typed folder.

### Workspaces are inferred, not declared

**Any folder containing a typed folder is automatically a workspace.** No registry, no manifest — the structure is read straight from the filesystem. `.iris/` is the default root workspace; sub-folder workspaces exist for independent exploration, time-boxed spikes, and other sub-project scenarios.

- **Creating one is a human gesture** (via a wizard; templates: standard four-folder / empty custom). Agents don't create workspaces unprompted.
- **Lexical scope:** when an agent writes back, it writes into the *nearest enclosing workspace* of `$FOCUS_DOC`. That path encodes both the document's type and its scope.
- **Live and die together:** a failed spike is `rm -rf`'d as one folder; a successful one promotes its valuable docs up to the parent.
- **Archiving trick:** move a finished workspace into the parent's `report/` — the "frozen past" contract makes the UI gray it out wholesale. Zero new concepts.

### Four freshness contracts

| Typed folder | Time semantics | Maintainer | Freshness contract | git merge behavior |
|--------------|----------------|-----------|--------------------|--------------------|
| `status/`    | Now            | AI        | Must equal *now* (strongest)   | Worst (a derived view) |
| `issue/`     | Future         | Human + AI| Valid until resolved           | Good (one file per thing) |
| `report/`    | Past           | AI        | Frozen at birth; append-only   | Perfect (grow-only set) |
| `misc/`      | Outside time   | Human     | No contract                    | Irrelevant |

**Event-sourcing reading:** `report/` is an append-only event log, `status/` is a materialized view, `issue/` is a pending queue. If `status/` drifts, it can be rebuilt from `report/` + the code — reports are the sedimentary ground truth, status is just their cache. The constitution asks the agent to append a session journal to `report/` after every task ("what I did and why"), which doubles as the project's searchable institutional memory.

### frontmatter and naming

```yaml
---
title: Service boundary design
status: In Progress        # a soft, recommended value — deviation allowed
reflects: a1b3c2           # agent-side stamp: which commit this doc reflects
labels: [auth, backend]    # soft values, passed through verbatim
---
```

- **Keys** are recognized literally (`status:` present → task view; `reflects:` → reserved for staleness calculation).
- **Values** are filled by the agent per the constitution; deviation is allowed.
- **File naming:** new files in `issue/` and `report/` carry a date prefix (`2026-06-10-auth-refactor.md`) so concurrent creation by multiple humans/agents never collides.

### The convention scope chain

Conventions resolve nearest-scope-first, inner to outer: **workspace ⊂ project ⊂ machine.**

- **Project layer** — `.iris/CONVENTIONS.md` (committed to git, shared by the team). Describes the *work itself*: folder semantics, stamping rules, write-back scope. Anything a collaborator needs to know to interpret these files lives here.
- **Machine layer** — `~/.iris/CONVENTIONS.md` (not in git, travels with the machine). Describes the *environment the work happens in*: corporate encryption software (name, how it interferes, whitelisted dirs, workaround), network proxy, VM constraints, resource limits, toolchain quirks.

The portability litmus test: *"this sentence stops being true on another machine"* → machine layer; *"this must hold on any checkout, anywhere"* → project layer. A senior engineer carries two kinds of knowledge — about the project, and about this machine. Externalize the first into the project layer and the second into the machine layer, and the agent reads like "someone who has worked on this box before."

`~/.iris/` and `.iris/` are isomorphic: each holds a `CONVENTIONS.md` (read by the **agent** — part of the protocol) and `settings` / `templates` (read by the **app** — software config). Neither parses the other.

### The injection chain and protocol version

Root `AGENTS.md` (one guidance section) → `.iris/CONVENTIONS.md` → `~/.iris/CONVENTIONS.md` (if present). Three hops, each with some compliance decay — so the machine layer should be the shortest of the three. The constitution's frontmatter carries `protocol: 1`; on a version mismatch the software only **prompts** with a diff — upgrading the constitution is a human gesture.

---

## The core gesture

**Select a document → right-click → "Open with X".**

This opens a new terminal session with:

- working directory = the project root,
- environment variable `FOCUS_DOC=<relative path of the selected doc>`,
- the agent launched **bare** (no task prompt injected).

The agent reads the constitution via the injection chain → reads `$FOCUS_DOC` per the protocol → has its context → and **stops, waiting for your instruction.** Opening is not dispatching: with no user message, there is no task. The whole point of this gesture is to kill the friction of manually pasting context every time you open an agent.

### Context injection is a rendering-layer adaptation, not the protocol

The shell only ever sets `FOCUS_DOC`. Turning that pointer into actual context is optional and layered:

- Agents with a **SessionStart hook** use the hook to expand the pointer into content (zero extra turns — the content enters context without the model being invoked). Iris ships a generated machine-level focus-context script (`~/.iris/focus-context.ps1`); it **detects, suggests, and — only after your explicit confirmation — writes** the hook into the agent's *own* config file (with a `.bak` backup). Out of the box it knows about Claude Code, Gemini CLI, Qwen Code, and Cursor CLI; Codex is detected but pointed at manual setup (its TOML config has its own trust review).
- Agents with a launch **flag** carry the pointer on the command line (e.g. `aider --read $env:FOCUS_DOC`).
- Agents with **neither** degrade gracefully to "read the AGENTS.md guidance and fetch the doc yourself" — which the protocol allows anyway.

Dynamic focus rides an environment variable (born and dies with the process); the static contract rides the constitution file. Two lifecycles, two pipelines.

### The session model: multiple sessions, detach not dispatch

- **Many concurrent sessions per project is the norm:** one anchored to an architecture doc, one to an issue, one to the project root. Sessions are anchored to documents; the root session is the unfocused fallback.
- **The anchoring model is borrowed from [Marina](#reuse-and-lineage):** the doc↔session binding is fixed at session creation and never changes; **one document can carry any number of sessions** (e.g. a `claude` and a `codex` side by side). Want to refocus mid-session? Just say so in the conversation — the protocol adds no mechanism for it.
- **Sessions are working memory; documents are long-term memory.** Sessions are cheap, disposable, re-openable; documents are permanent and accrete each session's output through write-back. A document is served by many sessions over its life; when a session dies, the document remembers.
- **Detach, not dispatch.** There is no headless dispatch. Sessions stay interactive and conversational — you simply aren't chained to the window: leave, come back, pick up. An agent's question waits, lit up, in the "waiting for input" state. Throughput comes from parallel sessions, not from surrendering the conversational control plane — so a review point always exists.

---

## The interface

Three panes.

- **Left — the lens tree.** Documents organized by lens: workspaces are the grouping level, types are the categories within. The `issue/` group shows only *active* issues — resolved ones don't take up your field of view. A **session status dot** sits next to each document (● working / ◐ idle-or-awaiting-input), turning the left pane into an attention scheduler that tells you *which thing is waiting on you*. A raw file-tree is a toggle-out escape hatch.
- **Middle — two levels.** Click a *type header* → the **collection view** (issues get a Linear-style management panel; other types get a simple one-file-per-row list). Click a *single document* → the **single-doc view**: a typed header (badges, fields) plus the body, edited Typora-style in WYSIWYG, with a source mode as the escape hatch for precise edits. **frontmatter never enters the body editor** — the header owns it.
- **Right — the terminal pane.** The vertical AI conversation panel. Clicking a doc in the left pane switches to its session; when a doc carries multiple sessions, the right pane includes a session list and switcher.

**The status dot** is decided by a pure PTY byte-stream activity heuristic — recent output = working, silence past a threshold = idle / possibly awaiting input. It only ever looks at whether bytes flowed, never at their content. The thresholds (2s silence, plus anti-flicker quiet windows for startup banners, resize echoes, and keystroke echo) are inherited from Marina, where they were already tuned.

---

## Collaboration, via git

The protocol holds up under multi-person git use, and the four folders' merge behavior is inversely proportional to their freshness contract (stronger contract → more painful merge):

- **`report/`** — grow-only set, near-zero conflicts; the date prefix all but guarantees no name clashes.
- **`issue/`** — one file per thing, so new files never interfere; a frontmatter conflict on the *same* issue is small, readable, and surfaces a real human disagreement — letting it surface is correct.
- **`misc/`** — everyone writes their own.
- **`status/`** — **a derived view is not merged, it's rebuilt** (the lockfile pattern). After a merge, just say "code just merged, refresh the affected status docs."
- **Self-healing fallback:** even if nobody refreshes, the constitution's trust-calibration rule tells the agent to treat a suspicious `status/` doc as a weak prior and verify against the code. The system doesn't go *wrong* from laziness — it just slows down, then heals.

Multi-person collaboration needs no new design; it just makes existing mechanisms (especially "the constitution is in git") matter more.

---

## What Iris deliberately doesn't do

These are current trade-offs with reasons, not identity commitments. When a reason stops holding, that one gets reopened.

- **No embedded agent, SDK, or API key** — you bring the CLI and the billing; the shell stays dumb. (This does not exclude *your* BYOK automations.)
- **No accounts, subscriptions, cloud, or telemetry** — your data stays in your hands.
- **No headless dispatch** — detach, not dispatch; the conversational control plane stays with the human.
- **No plugin system (yet)** — view extensions go through declarative config; truly custom logic means fork / PR. (You clone untrusted repos daily — executable code inside a repo would be "open = run a stranger's code.")
- **No note vault, no orchestration kanban, no code editor** — things others already do well aren't redone.
- **No parsing of agent output** — files are the contract.
- **No schema validation, no workspace manifest** — constraints stay in the convention layer.
- **The app never writes the constitution** — both constitution layers are hand-authored; the app only reads.

---

## Tech stack

The primary selection criterion is **AI readability**: React + Tailwind + shadcn is the highest-density frontend stack in training corpora, so an AI-written codebase has the lowest rework rate. For a codebase written largely by agents, a stack's popularity is itself a productivity feature.

| Layer | Choice | Notes |
|-------|--------|-------|
| Desktop shell | **Electron** (electron-vite) | Same stack as Marina, so the session layer is reused directly |
| Language / framework | **TypeScript + React 18** | |
| Business-logic layer | **front-cpu** (FrontCPU ISA) | Instruction pipeline with an interrupt system, pluggable executors, lifecycle guarantees |
| Components | **shadcn/ui + Tailwind** (Radix primitives) | Copy-in components; source lives in this repo |
| Render pipeline | **remark / unified** | Parse to AST, then interpret per type via a default config table |
| Body editor | **Crepe** (the Milkdown distribution) | Typora-style WYSIWYG |
| Source editor | **CodeMirror 6** | The raw-toggle escape hatch |
| File watching | **chokidar** | In the Electron main process |
| PTY | **node-pty + xterm.js** (webgl / fit / serialize / search / headless addons) | The session layer, reused from Marina |
| frontmatter | **gray-matter** | |
| License | **MIT** | |

**Design language:** inherited from its sister project Marina — **Rose Pine** color palette + **LXGW WenKai** (霞鹜文楷) typeface. v1 ships the three Rose Pine variants (dark `rose-pine`, light `dawn`, medium `moon`). The xterm.js theme and the Tailwind CSS variables are aligned to the same palette.

**Editor red line:** never build a bespoke CodeMirror live-preview — that ecosystem's history is a string of abandoned ships (HyperMD, MarkText). The polishing cost of tables/images/lists is exactly "the part that needs a lot of code," so it's bought off the shelf via Crepe.

---

## Architecture notes

### front-cpu: every side effect is one instruction

The business-logic layer doesn't roll its own side-effect channel. Every operation with a side effect is **registered as one instruction** (`registerISA`, named `{domain}.{operation}`); the UI only ever calls `pipeline.dispatch('doc.save', payload)`. Instructions flow through a five-stage pipeline (fetch → schedule → execute → respond → write-back); the schedule stage auto-detects resource conflicts by `resourceIdentifier` and supports several scheduling strategies (out-of-order / serial / latest / read-write).

This is the *one correct answer* given to agents writing the codebase: a new feature = a new instruction. The central instruction registry is an anti-entropy device — uniform, auditable diffs. ISA is to the codebase what `.iris/` is to the project: "hard keys" applied to the code itself.

Iris-specific usage:

- **The instruction body goes through an `ipc` executor**, staying declarative. There's no backend, so a ~10-line `ipc` executor (`registerExecutor('ipc', (config, payload) => ipcRenderer.invoke(config.channel, payload))`) gives the same declarative experience as an HTTP one.
- **No optimistic updates** — a local disk write has no network latency, so there's nothing to be optimistic about.
- **`doc.save` is serial per file path** (`resourceIdentifier: doc:{path}` + explicit `serial`), so rapid saves to the same doc never interleave; everything else is out-of-order by default.
- **Write-to-disk instructions get no cancellation** — front-cpu's cancellation is cooperative (it drops the *result*, not the side effect), and a "canceled" save may have already written, so write instructions simply opt out.

### CQRS boundary

The ISA only ever admits *verbs that change the world*. The projection from filesystem → render is a **reactive pure function** and does **not** go through the pipeline.

### External events go through the interrupt system

chokidar file events enter via `pipeline.interrupts.raise()` and an ISR updates the projection — they do **not** go through `dispatch`. Echo de-duplication inside the ISR uses a **deterministic state comparison only**, zero heuristics: the on-disk content hash equals the in-memory document state → no information gain → skip; mismatch → a genuine external edit → re-project. Because the editor is the source of truth and the in-memory state is already current before dispatch, there's no registration step and no timing race — the comparison is correct whether the file event arrives before or after the write completes.

```typescript
// main process watches .iris/ → IPC push to renderer → renderer raises the interrupt
ipcRenderer.on('fs:changed', (_evt, { path, content }) => {
  pipeline.interrupts.raise({ type: 'fs.doc.changed', source: 'file-watcher', data: { path, content } })
})

// projection ISR: state-compare de-dup — disk == memory → skip; else re-project
pipeline.interrupts.register({
  name: 'doc-projection',
  events: 'fs.doc.*',
  onInterrupt: (e) => {
    const { path, content } = e.data
    if (hash(content) === hash(docStore.get(path)?.content)) return // echo or equivalent edit
    reproject(path, content)
  },
})
```

### Zero-diff discipline

Serialization uses fixed remark defaults: **open-then-save must produce zero diff.** This is rule #9 the constitution asks of agents — and the app holds itself to it first. The editor store does frontmatter as line-level surgery, only re-serializes the body through Crepe when it actually changed, and skips the write entirely when nothing was edited; echo de-dup is an exact comparison against the last-written content.

### Reuse and lineage

The entire session layer is copied from the sister project **Marina** (a terminal/session manager by the same author) and lightly adapted, rather than rewritten: the PTY pool and `idle ↔ active → exited` state machine, the anti-flicker parameters, the anchoring model (rebased from path↔session to doc↔session), settings persistence (relocated to `~/.iris/`), the electron-vite scaffold, the Rose Pine palette, and the `XTERM_THEMES` object. The LLM-based status re-check and the SSH machinery were dropped — the dumb-shell principle forbids the former.

---

## Getting started

> Iris is Windows-first (terminal integration is built on ConPTY, with anti-flicker parameters already tuned for Windows). POSIX support is a later milestone.

```bash
npm install        # front-cpu is currently a local file: link; see package.json
npm run dev        # Vite HMR + Electron
npm run typecheck  # tsc --noEmit across the three process tsconfigs
npm run build      # typecheck + electron-vite build (output in out/)
npm run smoke      # startup smoke test against the out/ build (build first)
npm test           # vitest
npm run dist       # build + electron-builder (Windows portable, x64)
```

### Cold start (the protocol bootstraps itself)

No special feature needed. Once the scaffold exists, open a session on the project root and say one sentence:

> "Read this codebase and, following `.iris/CONVENTIONS.md`, generate the initial status docs and stamp them with HEAD."

The protocol self-bootstraps from there.

---

## License

[MIT](LICENSE).
