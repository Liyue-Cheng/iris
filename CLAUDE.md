# CLAUDE.md

## 这是什么项目

Iris（暂定名）：一个 AI 原生、文档中心、终端驱动的项目管理工具。它是套在"一堆 markdown 文件 + 一池终端会话"上的最薄外壳：所有项目数据是 `.iris/` 下类型文件夹里的纯文本 md（文件系统即数据库），所有智能外包给用户本机的 agent CLI（claude/codex/...）。核心手势：选中文档 → 右键 → 用 X 打开 → 新终端注入 `FOCUS_DOC` 环境变量、裸启动 agent。

**协议先行**：本体是协议（`.iris/` 目录约定 + 一份散文宪法 CONVENTIONS.md），应用只是协议的参考实现（查看器 + 召唤器）。

## 权威文档（动手前先读）

- `software-definition.md` — 产品与协议定义。**任何实现决策与它冲突，以它为准。**
- `technical-design.md` — 技术栈选型与复用来源。
- `roadmap.md` — 开发路线图。**开发严格按里程碑推进。**

## 开发纪律

- 一次只做一个里程碑，不跨里程碑开发。当前进度看 `roadmap.md` 与 git 历史。
- **每个里程碑完成后必须停下**，提醒用户按 roadmap 对应的"✋ 手工测试点"清单做手工验收；验收通过前不进入下一个里程碑。
- 遇到定义书未覆盖的产品决策（交互细节、命名、取舍），停下来问用户，不自行裁决。

## 技术栈

Electron（electron-vite）+ TypeScript + React 18 + Tailwind + shadcn/ui；业务逻辑层 front-cpu（流水线 ISA）；渲染 remark/unified；正文编辑 Crepe（Milkdown）；源码编辑 CodeMirror 6；PTY node-pty + xterm.js；文件监听 chokidar。License：AGPL-3.0。设计语言：Rose Pine 三变体 + 霞鹜文楷。

## 代码范式（front-cpu）

- **一切副作用 = 一条指令**：`registerISA` 注册，命名 `{domain}.{operation}`，UI 只 `pipeline.dispatch()`。新功能 = 注册一条新指令——这是给 agent 的唯一正确答案，不要发明第二种副作用通道。
- **CQRS 边界**：ISA 只收"改变世界"的动词；文件系统 → 渲染的投影是反应式纯函数，不进流水线。
- **外部事件走中断**：chokidar 事件经 `pipeline.interrupts.raise()` 进入，ISR 内去重**只用确定性状态比对**（盘上内容 hash = 内存状态 → 跳过），零启发式。
- 指令体走 `ipc` executor 保持声明式；`doc.save` 按 `doc:{path}` 串行；写盘指令不配取消、不配 optimistic。
- 目录结构照 cutie：`src/cpu/`（`index.ts` 实例化 + `isa/` 按领域分文件 + `cpu-adapters/`）。实例级配置，不用全局单例。

## 复用来源（不重写，复制后小改）

- **Marina** `E:\projects\terminal` — 整个会话层：`src/main/session-manager.ts`（PTY 池/状态机/防闪烁参数）、`path-manager.ts`（锚定模型，路径改文档）、`settings-manager.ts`（存储改 `~/.iris/`）、`src/shared/types.ts`、electron-vite 脚手架、Rose Pine Layer 1 色板与 `XTERM_THEMES`。复制时砍掉 `ai-client.ts` 和 ssh 系列。
- **cutie** `E:\projects\dashboard\cutie\src\cpu` — front-cpu 接入姿势（目录结构、ISA 写法、correlationIdAdapter）。它的 vueAdapter 在 Iris 换成 React 版 reactiveStateFactory。
- **front-cpu** — 0.3.0 尚未发布到 npm（注册表只有 0.1.4），当前用 `file:../dashboard/cpu-pipeline` 本地链接；发布后改回注册表版本。不复制源码；本体仓库在 `E:\projects\dashboard\cpu-pipeline` 可查 API 与文档（`docs/API.md`、`dist/*.d.ts`）。注意：`InstructionMeta.category` 是受限枚举（debug/task/schedule/system/area），`priority` 必填。

## 红线（违反 = 错误，不是品味问题）

- 不内嵌 agent、SDK、API key——壳保持哑，智能来自用户自带的 CLI。
- 不解析 agent 的终端输出——**文件才是契约**，一切经文件监听。
- 永不自研 CodeMirror live-preview（该生态历史是一连串弃船）。
- 不做 schema 校验、不加 manifest/注册表——结构全部从文件系统推断（名字即类型、工作区推断）。
- `.iris/CONVENTIONS.md` 是用户手写契约：App 只读，agent（包括你）不许修改。
- 渲染层保持确定性：键按字面解析，不在渲染层引入启发式或 LLM。
- Iris 自有数据只住 `.iris/`（项目级）与 `~/.iris/`（机器级），不打扰用户项目根（唯一例外：经用户确认向 AGENTS.md 追加引导段）。
- 序列化用固定 remark 默认配置：打开即保存必须零 diff。

## 环境与约定

- Windows 11 + PowerShell；终端集成基于 ConPTY（防闪烁参数已在 Marina 上为 Windows 调好，照抄）。
- 与用户交流用中文；代码、标识符、注释、commit message 用英文。
- 项目文档（定义书/设计书/路线图及 `.iris/` 内文档）用中文。

## 常用命令

- `npm run dev` — 启动开发模式（Vite HMR + Electron）
- `npm run typecheck` — 三进程分别 tsc --noEmit
- `npm run build` — typecheck + electron-vite build（产物在 out/）
- `npm run smoke` — 对 out/ 产物做启动冒烟测试（先 build）

## 代码结构速览

- `src/main/` — 主进程：index.ts（窗口）、ipc.ts（所有 ipcMain handler）、iris-scanner.ts（协议读侧：名字即类型/工作区推断，纯函数+单测）、project-manager.ts（项目生命周期 + chokidar 监听）、settings-manager.ts（设置，存 `~/.iris/settings.json`）、persistence.ts（JsonStore 原子写，Marina 移植）
- `fixtures/sample-project/` — 协议测试夹具（嵌套工作区、归档工作区、损坏 frontmatter 等边角案例），单测和手工验收共用
- 坑：gray-matter 不带 options 调用会在解析抛错前写缓存，同内容第二次解析变假成功——必须 `matter(text, {})`
- `src/preload/index.ts` — 最薄桥：window.api.invoke / on
- `src/shared/` — protocol.ts（IPC 频道常量）、types.ts（共享模型）
- `src/renderer/cpu/` — front-cpu 集成层：isa/（按领域分文件）、cpu-adapters/（ipc executor、reactive state、correlation id）
- `src/renderer/stores/` — 投影层（反映世界，不进流水线）
- `src/renderer/components/ui/` — shadcn 拷贝式组件；layout/ — 三栏壳
- `src/renderer/styles/global.css` — 两层主题 token（--rp-* → shadcn 标准 token），改主题同时改 theme/xterm-themes.ts
