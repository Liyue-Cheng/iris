# 开发路线图 — Iris v1

> 本文是**执行计划**：里程碑划分、每个里程碑的范围与手工验收测试点、第一阶段的详细开发顺序。
> 产品语义见《软件定义书》，技术选型见《技术设计书》。与二者冲突时，以定义书为准。

## 纪律

1. **一次只做一个里程碑。** 里程碑内的任务可以调整顺序，但不跨里程碑开发。
2. **每个里程碑以"✋ 手工测试点"收尾**：代码完成后停下，由人按清单逐项验收。全部通过才进入下一个里程碑；不通过则修复后重测。
3. 每个里程碑自带的自动化测试（单测/冒烟）随代码交付，手工测试不替代它们，只验收"机器测不了的体感"。
4. 开发中遇到定义书未覆盖的产品决策，停下来问人，不自行裁决后继续。

## 总览

| 里程碑 | 主题 | 一句话交付物 |
|--------|------|--------------|
| M0 | 工程骨架与主题 | 能跑起来的三栏空壳：Rose Pine 主题 + front-cpu 流水线全链路打通 |
| M1 | 协议只读层 | 真实 `.iris/` 树被正确投影成左栏透镜树，外部改动实时反映 |
| M2 | 单篇文档编辑 | 类型化头部 + WYSIWYG + 源码模式 + 静默保存回路（回声去重） |
| M3 | 会话层与核心手势 | 右键"用 X 打开"、`FOCUS_DOC` 注入、会话状态点 —— **dogfood 自此开始** |
| M4 | 类型集合视图 | Linear 风格 issue 管理面板 + 其余类型列表 + 归档灰化 |
| M5 | 向导与冷启动 | 项目 init 脚手架、工作区创建向导、机器层、协议版本提示 |
| M6 | v1 收口 | 边界情况、打包发布、一轮完整验收 |

依赖关系基本是线性的 M0 → M1 → M2 → M3 → M4 → M5 → M6。唯一的弹性：M4 只依赖 M2，如果 M3（会话层）期间需要等待决策，M4 可以提前插队。

---

## M0 — 工程骨架与主题

**目标**：一个能启动、有正确视觉基因、业务逻辑范式已经立住的空壳。这一里程碑几乎全是"从 Marina / cutie 搬运"，新写代码极少。

### 范围

- 从 Marina（`E:\projects\terminal`）整体照搬 electron-vite 工程脚手架：三进程 tsconfig、`electron.vite.config.ts`、构建与 smoke 测试脚本、package.json scripts。剔除 Marina 业务依赖（ssh 系列、tray 等）。
- 安装基础依赖：React 18、Tailwind、shadcn/ui（components.json 初始化 + 首批基础组件）、front-cpu（npm 包，≥0.3.0，不复制源码）。
- 主题系统：Layer 1 照搬 Marina 的 Rose Pine 三变体 hex（含 Dawn 对比度修正），Layer 2 手工映射约 20 个 shadcn 标准 token，`[data-theme]` + `color-scheme` 切换机制照搬；字体栈（LXGW WenKai + 回退）；`XTERM_THEMES` JS 对象一并搬来（M3 才用，先归位）。
- 三栏布局空壳（左/中/右，可拖动分隔）。
- front-cpu 接入：`src/cpu/` 目录（`index.ts` 实例化 + `isa/` + `cpu-adapters/`），照抄 cutie 的结构；注册 `ipc` executor（约 10 行）；cutie 的 `vueAdapter` 换写成 React 版 `reactiveStateFactory`；`correlationIdAdapter` 照搬。实例级配置（`new Pipeline({...})`），不用全局单例。
- 一条端到端演示指令 `app.ping`：renderer dispatch → ipc executor → 主进程 → 返回，证明流水线全链路通。
- 复制 Marina 的 `settings-manager.ts`，存储位置改到 `~/.iris/`，先只承载主题选择的持久化。

### 明确不做

- 不碰 `.iris/` 扫描、编辑器、PTY。三栏里放占位内容。

### ✋ 手工测试点 M0

1. `npm run dev` 启动出窗口，三栏布局可见、分隔条可拖动。
2. 主题切换器在 rose-pine（默认深色）/ dawn / moon 三档之间循环，整窗颜色正确切换，UI 字体为霞鹜文楷（机器已装该字体）。
3. 重启应用，主题选择被记住（确认 `~/.iris/settings.json` 已生成且内容合理）。
4. 点调试按钮触发 `app.ping`，界面上能看到经主进程返回的响应（证明 Pipeline → ipc executor → IPC → 主进程链路通）。
5. `npm run build` 成功，无类型错误。

---

## M1 — 协议只读层

**目标**：协议的"读半边"成立——任意手建的 `.iris/` 树都能被正确解析为工作区/类型/文档结构，渲染进左栏，且外部改动实时反映。这是确定性渲染层的承重墙，值得测试得最狠。

### 范围

- **测试夹具**：建 `fixtures/sample-project/`，包含根工作区四类型文件夹、一个嵌套子工作区（含部分类型文件夹）、带各种 frontmatter 的文档（规范值/偏离值/缺失/损坏）、`misc/` 里的杂物、一个被归档进 `report/` 的完整工作区。夹具同时服务后续所有里程碑的手测。
- **主进程扫描器**：递归扫描 `.iris/`，实现两条协议规则——"名字即类型"（任意深度的 `status/`/`issue/`/`report/`/`misc/` 按类型解析，文档类型由最近的类型文件夹决定）与"工作区推断"（任何包含类型文件夹的文件夹即工作区，零注册表）。frontmatter 解析（gray-matter 或 remark 前置步骤），损坏的 frontmatter 不崩溃、降级为无元数据文档。
- **文件监听回路**：chokidar 在主进程盯 `.iris/` 树 → IPC 推送 renderer → `pipeline.interrupts.raise()` → 投影 ISR 更新文档 store。本里程碑粒度从粗（变更即增量重扫对应子树）做起，状态比对去重留到 M2（此时还没有应用侧写盘，没有回声）。
- **左栏透镜树**：工作区为分组层级、组内按类型分类；issue 分组只显示活动中的（resolved/done 不占视野）；裸文件树 toggle 逃生舱；会话状态点先放占位（M3 点亮）。
- **中栏只读预览**：点文档 → remark 管线渲染只读视图（简单版，类型化头部和编辑留给 M2）。
- **打开项目手势**：文件夹选择器 + 记住上次打开的项目（v1 一次一个项目）。

### ✋ 手工测试点 M1

1. 打开 `fixtures/sample-project`：左栏结构与夹具设计完全一致——根工作区四类型分组正确，嵌套子工作区作为独立分组出现，深层类型文件夹被正确识别。
2. issue 分组只看得到活动中的 issue；把某个 issue 文件的 `status:` 改成 resolved（用外部编辑器），它从左栏消失。
3. 外部新建一个 `report/2026-06-11-test.md` → 1 秒内出现在树里；外部删除 → 消失；外部改某文档的 `title:` → 树上标签即时更新。
4. 损坏 frontmatter 的文档正常显示（按文件名兜底），应用不崩、不弹错。
5. 切换裸文件树 toggle，看到未加透镜的真实目录结构，再切回来。
6. 点任意文档，中栏渲染出可读的 markdown 预览（标题、列表、代码块、表格正常）。
7. 打开一个没有 `.iris/` 的文件夹，得到优雅的空状态（提示而非报错；init 向导是 M5 的事）。
8. 重启应用自动回到上次打开的项目。

---

## M2 — 单篇文档编辑

**目标**：中栏成为可信赖的编辑器——frontmatter 由类型化头部拥有、正文 Typora 式所见即所得、源码模式逃生舱，且保存回路对 diff 静默、对回声免疫。

### 范围

- **类型化头部**：徽章 + 字段编辑（`status:` 软状态机下拉但允许自由值、`title:` 等）；frontmatter 不进正文编辑器，头部是它唯一的 UI。
- **Crepe 集成**（本里程碑最大的新集成风险）：喂给 Crepe 前剥离 frontmatter，保存时重新拼接；序列化用固定 remark 默认配置——**"打开即保存须产生零 diff"是硬验收标准**（宪法第 9 条对 agent 的要求，应用自己首先要做到）。
- **CodeMirror 6 源码模式**：raw toggle，整文件（含 frontmatter）精确编辑。
- **写盘指令**：`doc.save`（`resourceIdentifier: doc:{path}` + 显式 serial；不配 optimistic、不配取消 tag）；`doc.create`（`issue/`、`report/` 新建带 `YYYY-MM-DD-` 日期前缀）。保存策略：显式保存（Ctrl+S）+ 切换文档/失焦自动保存。
- **回声去重**：投影 ISR 加入状态比对——盘上内容 hash 等于内存文档状态即跳过（自己写盘的回声或等价修改），不一致才重投影（真正的外部修改）。
- 脏状态指示、未保存切换的兜底。

### ✋ 手工测试点 M2

1. **零 diff 测试（最重要）**：对夹具里每一篇文档执行"打开 → 不做任何编辑 → 保存"，用 `git diff`（夹具先 git init）确认零变更。有 diff 即不通过。
2. WYSIWYG 编辑：改标题、列表、表格、代码块，保存后用外部编辑器查看磁盘文件，markdown 干净、frontmatter 原样保留。
3. 头部把 `status:` 从 `todo` 改 `in_progress`：frontmatter 更新、正文一字不动；填一个状态机之外的自由值也能存。
4. 文档在 Iris 中打开时，用 VSCode 改同一文件并保存 → Iris 视图即时更新；反过来 Iris 保存 → 自己的视图不闪烁、不重投影（回声去重生效）。
5. 源码模式：toggle 进入，看到含 frontmatter 的完整源码；编辑后切回 WYSIWYG，内容一致。
6. 连续快速保存同一篇（连按 Ctrl+S 改字再按）不丢内容、不交错（serial 调度生效）；同时编辑两篇互不干扰。
7. 在 issue 类型下新建文档，文件名自动带今天的日期前缀。

---

## M3 — 会话层与核心手势

**目标**：产品的价值重心落地——"选中文档 → 右键 → 用 X 打开"。会话层整体从 Marina 复制小改，不重写。**本里程碑验收通过后，立即在 Iris 仓库自身手建 `.iris/`，用 Iris 开发 Iris。**

### 范围

- **从 Marina 复制**：`session-manager.ts`（PTY 池、idle↔active→exited 状态机、防闪烁）、`path-manager.ts`（锚定模型，pathId 改为文档相对路径，三分类简化）、`src/shared/types.ts` 相关模型、PTY 工具与 IPC 聚合（8ms 批量窗口）。**砍掉** `ai-client.ts`（哑壳原则）及 ssh/known-hosts 等 Marina 特有部分；多窗口所有权代码保留不剔（免费的未来基础）。
- **右栏终端**：xterm.js + webgl/fit/serialize addon，`XTERM_THEMES` 与 CSS 变量对齐同一色板。
- **核心手势**：左栏右键 → "用 X 打开"（agent 清单可配置，存 `~/.iris/settings.json`，默认含 claude）→ 新 PTY，cwd=项目根，注入 `FOCUS_DOC=<文档相对路径>`，**裸启动**不传 prompt。
- **锚定模型**：绑定创建时确定、终生不变；一篇文档可挂任意多个会话；右栏含会话列表与切换；项目根会话作无聚焦兜底（不注入 `FOCUS_DOC`）。
- **状态点**：左栏每篇文档旁 ●（工作中）/ ◐（空闲/等输入），纯 PTY 字节流启发式，参数照抄 Marina：静默阈值 2s、启动期 grace 1500ms、resize 回声 500ms、按键回显 200ms。
- 会话生命周期：随应用进程存活，关应用即死（会话是工作记忆，文档才是长期记忆）。

### ✋ 手工测试点 M3

1. **核心手势全链路**：在夹具项目（已放好附录 A/B 的 AGENTS.md 与 CONVENTIONS.md）对某文档右键 → 用 claude 打开 → 终端出现、claude 裸启动后停住等指令。输入"当前聚焦文档是什么？它属于哪个工作区？"——agent 不经任何手动粘贴即正确回答（证明注入链 AGENTS.md → 宪法 → `$FOCUS_DOC` 走通）。
2. 让 agent 在该文档所属工作区完成一个小任务（如"给这个 issue 补充一段分析"），确认它写回了正确的作用域，且左栏/中栏经文件监听自动反映改动——**应用读回路与 agent 写回路在此闭环**。
3. 状态点：agent 工作时 ●，停下等输入约 2 秒后转 ◐；在终端里打字（回显）不点亮；resize 窗口不点亮。
4. 同一篇文档再开第二个会话（另一个 agent 或再开一个 claude），右栏列表显示两个会话、切换流畅、互不串扰。
5. 对项目根开兜底会话，确认无 `FOCUS_DOC`（让 agent `echo $FOCUS_DOC` / `$env:FOCUS_DOC` 验证）。
6. 切到别的文档再切回来，会话还在、滚动缓冲完整（detach 而非杀死）。
7. 长输出压力：让 agent cat 一个大文件，UI 不卡死（IPC 聚合生效）。
8. **开始 dogfood**：在 Iris 仓库自身手建 `.iris/` + 宪法，用 Iris 打开 Iris，从此后续里程碑的开发工作经由它进行。

---

## M4 — 类型集合视图

**目标**：中栏的第一层级——点类型栏标题进入集合视图。issue 是重头戏，其余从简。

### 范围

- **issue 面板**（Linear 风格，列表起步）：标题/状态/日期列，按状态过滤（含已解决——左栏不显示的在这里能找到），点行进单篇视图，"新建 issue"按钮走 `doc.create`。
- **其余类型**：status / report / misc 一行一文件的简单列表。
- **归档灰化**：被挪进父级 `report/` 的整个工作区，按"冻结的过去"契约整体灰化渲染（夹具里已有现成案例）。
- 看板视图、过期标签等留给 v1 后。

### ✋ 手工测试点 M4

1. 点 issue 栏标题进入面板：夹具里所有 issue（含已解决）按状态过滤可见；左栏依旧只显示活动中的。
2. 面板里新建 issue → 文件落在正确工作区的 `issue/` 下、带日期前缀 → 即时出现在列表和左栏。
3. 在面板把某 issue 标为 resolved → frontmatter 更新、从左栏消失、面板过滤"已解决"可见。
4. 归档工作区在树和集合视图中整体灰化，文档仍可打开阅读。
5. 在 dogfood 环境用 issue 面板管理 Iris 自己的真实 issue 一天，记录体感问题。

---

## M5 — 向导与冷启动

**目标**：从"手建协议"到"软件代建脚手架"。协议自举的完整链路用真实 agent 验收。

### 范围

- **项目 init 向导**：检测到无 `.iris/` 时提供初始化——建四类型文件夹、写入宪法模板（定义书附录 B）、经用户确认后向根 AGENTS.md 追加引导段（附录 A；无则创建，有则追加，重复运行不重复追加）。
- **工作区创建向导**：标准四文件夹 / 空自定义两种模板（创建是人的手势，agent 不代劳）。
- **机器层**：`~/.iris/CONVENTIONS.md` 模板的安装手势（附录 C，写入前让用户填空或留 TODO）；templates 目录。
- **协议版本**：读宪法 frontmatter `protocol:`，非 1 或缺失时只提示 diff，不代改。
- 向导级 onboarding（引导新手的教学流）继续不做，留待 v1 后。

### ✋ 手工测试点 M5

1. **冷启动全链路（本里程碑的灵魂）**：找一个真实的、无 Iris 痕迹的代码仓库 → Iris 打开 → init 向导走完 → 检查生成的 `.iris/` 结构、宪法内容、AGENTS.md 追加段与定义书附录一字不差 → 对项目根开 claude 会话，说"读这个代码库，按 `.iris/CONVENTIONS.md` 生成初始 status 文档并盖 HEAD 戳" → agent 生成的文档位置正确、frontmatter 带 `reflects:`、左栏即时出现。
2. 重复运行 init，AGENTS.md 不出现重复段落。
3. 用向导建子工作区 `spike-test/`（标准模板）→ 对其中文档开会话让 agent 干一件小事 → 写回落在子工作区而非根（最近作用域规则）。
4. 把宪法 `protocol:` 改成 2 → 应用提示版本差异、不修改文件。
5. 装好机器层宪法后开新会话，问 agent 一个只有机器层才知道的事实（如代理端口），回答正确（三跳注入链全通）。

---

## M6 — v1 收口

**目标**：从"功能都有"到"能交给别人用"。

### 范围

- 边界情况清扫：超大 `.iris/` 树的性能、类型文件夹里的非 md 文件、只读文件系统、路径含空格/中文、PTY 进程异常退出的 UI 表现、应用崩溃后重启的状态恢复。
- 错误边界与日志（本地日志，无遥测）。
- electron-builder 打包（Windows 优先），AGPL-3.0 license 文件与第三方声明。
- 文档：README（协议先行的叙述顺序：先协议规范，应用作为参考实现）。
- 命名决议：`.iris/` 占位名的最终决定与全局替换在打包前完成。

### ✋ 手工测试点 M6

1. 全量回归：M1–M5 的手工测试清单完整重跑一遍（此时全部在打包产物上跑，不在 dev 模式）。
2. 安装包在一台干净 Windows 机器（或新用户目录）上安装、首启、冷启动一个新项目。
3. **一周 dogfood 验收**：连续一周完全用 Iris 管理 Iris 的开发（issue 进面板、status 由 agent 维护、report 留会话日志），周末复盘卡点清单，决定哪些进 v1.1。

---

## 第一阶段开发指引（M0 详细步骤）

按顺序执行，每步可独立验证：

1. **搬脚手架**：从 `E:\projects\terminal` 复制 electron-vite 工程骨架（`electron.vite.config.ts`、三进程 tsconfig、`package.json` 的 scripts 与 devDependencies、smoke 测试脚本、`.gitignore`）。改项目名为 iris，剔除 Marina 业务依赖（ssh 系列、`@anthropic-ai/sdk`、`openai`、tray 相关）。`git init` 并打首个 commit。
2. **最小可启动**：主进程 `index.ts` 只留开窗逻辑，renderer 渲染一个 Hello World。`npm run dev` 出窗口即过。
3. **Tailwind + shadcn**：初始化 Tailwind 与 `components.json`，拉首批组件（button、dropdown-menu、resizable、tooltip、dialog）。
4. **主题系统**：从 Marina `src/renderer/styles/global.css` 摘出 Rose Pine 三变体的 Layer 1 hex → 新写 Layer 2 映射到 shadcn 标准 token（`--background`/`--foreground`/`--primary`/`--card`/`--border`/`--ring` 等约 20 个 × 3 变体）→ `[data-theme]` + `color-scheme` 切换照搬 → 字体栈与 `XTERM_THEMES` 对象搬入。
5. **三栏布局**：shadcn resizable 搭左/中/右空壳，各放占位文案。
6. **settings-manager**：从 Marina 复制，存储路径改 `~/.iris/settings.json`，接上主题持久化与切换 UI。
7. **front-cpu 接入**：`npm i front-cpu`；建 `src/cpu/`（`index.ts` 实例化 Pipeline、`isa/app.ts`、`cpu-adapters/`）；照 cutie 的 `correlationIdAdapter` 搬运；写 React 版 `reactiveStateFactory`；注册 `ipc` executor；注册 `app.ping` 指令（`executor: 'ipc'`，主进程 handler 返回 pong + 时间戳）；renderer 放一个调试按钮 dispatch 它。
8. **收尾**：`npm run build` 通过；自查 M0 手工测试清单后，**停下来交人验收**。

M1 起，每个里程碑开工前先把本路线图对应小节过一遍，把范围拆成任务清单再动手；完成后同样停在手工测试点等验收。
