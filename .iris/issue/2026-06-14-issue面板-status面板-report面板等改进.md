---
title: issue面板 status面板 report面板等改进
status: In Review
priority: medium
labels: []
---
我之前说这个应该做成Linear风格，但是现在的实现效果，显然是非常粗糙，不堪使用的，你首先看看我们现在实现的是什么，然后你自己找一下linear截图，然后你提出10个改进建议，包括功能增强和排版改进，方案有了之后不要直接开始做，而是将相关信息打印在这下面，现在开始

---

## 一、现在实现的是什么（盘点）

三个集合视图都在中栏（`MiddlePane` 按 `view.kind` 分派）：

- **Issue 面板**（`IssuePanel.tsx`）：一张扁平 HTML `<table>`，列为 `标题 / 优先级 / 状态 / 标签 / 工作区 / 日期`。顶部一行有三段过滤 tab（活动中 / 已解决 / 全部，带计数）、工作区过滤 chip、标签过滤 chip、右侧「新建 issue」。优先级用文字药丸（urgent/high/...）、状态用 `StatusBadge`，二者都可内联下拉改值。排序固定为「优先级 → 日期倒序 → 路径」。归档工作区行 `opacity-50`。
- **Status / Report / Misc 面板**（`SimpleList.tsx`）：三种类型共用同一个「一行一文档」列表——标题 + 损坏/归档图标 + 工作区 + 日期，按日期倒序。Status 和 Report 视觉上**完全一样**，没有任何类型特异性。
- **待办面板**（`TodoPanel.tsx`）：把活动 issue 正文里未勾选的 `- [ ]` 按源文档分组，已经是分组形态（相对最接近 Linear）。
- 徽章体系（`badge.tsx` + `style-maps.ts`）其实做得不错：solid/soft/outline/dot × 7 色的模板库，状态/标签共用，软值降级到灰。这是可复用的好底子。

**和 Linear 的核心差距**（对照 Linear 文档：分组段头带计数且 sticky/可折叠、行首是优先级图标 + 状态环图标、Display 弹层切换分组/排序/可见列、键盘优先、行尾 hover 快捷操作）：

1. Issue 面板是「电子表格」而不是「列表」——扁平 table、无分组、行偏高，观感是 Excel 不是 Linear。
2. 优先级是文字药丸，没有 Linear 标志性的优先级条形图标；状态在列里而非行首的状态环。
3. 没有 Display/分组能力，只有三个写死的 tab。
4. 纯鼠标，零键盘（无 j/k 导航、无 c 新建、无 x 多选）。
5. Status 与 Report 共用裸列表，浪费了它们各自的语义（status 有 `reflects:` 时效、report 是时间线）。

## 二、10 条改进建议（先评审，勿动手）

### A. 功能增强

1. **可切换分组（Group by）+ sticky 可折叠段头**——这是 Linear 列表的灵魂。Issue 面板支持按 `状态 / 优先级 / 工作区 / 标签` 分组，段头显示组名 + 计数且滚动时吸顶、可折叠。协议契合：分组键全是盘上已有字段，纯函数投影、确定性，不碰红线（不做启发式）。默认「按状态分组」。

2. **Display 弹层（显示选项）**——右上角一个「显示」按钮，弹出：分组依据、排序依据（优先级/日期/标题/状态）、升降序、可见列开关。替代现在写死的排序与三 tab。状态存到 `~/.iris/settings.json` 或 `.iris/`（视图偏好，非项目数据），与现有 `settings-manager` 一致。

3. **文本搜索框 + 组合过滤**——顶栏加一个即时搜索框（匹配标题/标签/正文片段），并把「活动中/已解决/全部」「工作区」「标签」统一成可叠加的过滤芯片栏。当前只能点标签/工作区，缺最基本的搜文字。纯前端 filter，不进流水线。

4. **键盘导航与操作**——`j/k` 上下移动高亮行、`Enter`/`o` 打开、`c` 新建、`x` 多选、聚焦行上直接 `s`/`p` 触发状态/优先级菜单。Linear 是键盘优先工具，这是「不堪使用」到「顺手」的关键一跃。

5. **多选 + 批量操作**——`x`/Shift 多选后，底部浮出操作条：批量改状态、改优先级、加标签、移动工作区。批量改值落到逐条 `setDocStatus`/`setDocField`（已有），按 `doc:{path}` 串行写盘，符合现有指令约束。

6. **Status 面板时效化**——Status 文档带 `reflects: <sha>`（CONVENTIONS §status）。面板对每篇 status 显示它落后 HEAD 多少（新鲜/N 个提交前/陈旧），陈旧的高亮提醒重新生成。数据已在盘上，只是没投影出来；这把 status 面板从「又一个裸列表」变成真正反映「当前真相」的仪表盘。

### B. 排版与视觉改进

7. **行首状态环 + 优先级图标，提升密度**——抛弃 table 改为列表行：行首一个 Linear 式状态环图标（用现有模板色画 SVG 进度环），紧跟优先级条形图标，然后标题占主，标签/工作区/日期右对齐淡化。行高压到 ~32–36px、单行不换行，整体更紧、更像 Linear。优先级文字药丸退化为图标 + tooltip。

8. **统一的网格对齐与留白**——当前 table 的 `uppercase tracking-wider` 表头很「后台管理系统」，不是 Linear。去掉大写表头，列对齐改用固定栅格（grid 行模板），列间距/字号统一到一套 token；hover 行只做极轻的背景变化 + 行尾淡入快捷操作区，去掉边框线噪音。

9. **Report 面板做成时间线**——report 是 append-only 的过去快照，最适合时间线呈现：按日期（今天/本周/更早）分组的竖向时间线，每条显示相对日期 + 标题 + 首段预览片段。和 Issue 的分组列表区分开，不再与 status 共用裸列表。

10. **空态 / 计数 / 微观一致性打磨**——三个面板的空态、计数徽章、过滤芯片、字号字色统一成一套规范；优先级/状态色与左栏 lens 一致；统一「新建」按钮位置与样式。把现在各面板各写一套的零碎样式收敛成共享的列表行/段头/工具栏组件，保证三个面板观感同源。

### 建议落地顺序（评审后再定）

先 7 + 8（行/排版重做，立刻把「粗糙」摘掉）→ 1 + 2（分组 + Display，补齐 Linear 骨架）→ 3 + 4（搜索 + 键盘，进入「好用」）→ 5（批量）→ 6 + 9 + 10（类型特异化与打磨）。

## 三、行内排版的具体毛病（宽度 / 位置 / 换行）

上面第 7~10 条是「方向」，但更底层的问题在每一行的**宽度分配、截断与换行机制**——这些是结构性 CSS bug，不修好，换皮也还是会乱。逐条核过代码：

1. **截断全线失效（最严重）。**
   - flex 行：`truncate` 所在的 flex item 没有 `min-w-0`，而 flex item 默认 `min-width:auto` 不收缩，于是 `truncate` 根本不触发——长标题不出省略号，反而把右侧工作区/日期挤出去甚至溢出。见 `SimpleList.tsx:78`、`TodoPanel.tsx:111`（组头标题）。
   - table 行：标题 `<td>` 没有宽度、整表又没 `table-layout: fixed`，自动布局里 `truncate` 不生效，长标题直接撑宽整张表；见 `IssuePanel.tsx:211/236-237`。工作区列把 `truncate` 加在 `<td>`（table-cell）上同样不可靠，缺 `max-width`；见 `IssuePanel.tsx:263`。
   - 修法：flex 项给 `flex-1 min-w-0`；table 改 `table-fixed` + 列定宽 + 单元格 `max-w-0` 配 `truncate`。

2. **横向溢出无出口。** 滚动容器只有 `overflow-y-auto`，没有 `overflow-x`（`IssuePanel.tsx:210`）；一旦第 1 条把内容撑宽，内容溢出面板被裁切，且 `thead` 的 `sticky top-0`（`IssuePanel.tsx:212`）会和表体横向错位。修法：先根除撑宽，容器再 `overflow-x-hidden`，列宽改百分比 / fr 自适应。

3. **行高不定、节奏参差。** 标签列 `flex flex-wrap gap-1` 会换行（`IssuePanel.tsx:252-261`），标签一多该行变高 → 列表高低不齐，丢掉 Linear 单行刚性节奏。修法：标签区改单行 `flex-nowrap overflow-hidden`，超出折叠成 `+N`；行强制定高、不换行。

4. **空间分配倒挂。** 价值最低的列（工作区 `w-36`、日期 `w-28`、状态 `w-32`、标签 `w-44`）拿到**保证的固定像素**，价值最高的标题列只分到剩余空间。中栏宽度可变（左栏最高 40%、右区 `minSize=30`，见 `ThreePane.tsx:53/57`），窄时固定列总和（≈650px）吃满，标题被压到几乎为零。修法：标题 `flex-1` 主导，次要列设可压缩上限或在窄宽下隐藏（响应式）。

5. **table 自动布局忽略声明宽度。** 没有 `table-layout: fixed`，`w-24/w-32/...` 只是建议值，浏览器按内容重算列宽（`IssuePanel.tsx:211`）→ 实际宽度与设计不符、不稳定。修法：`table-fixed`，或干脆弃 table 改 CSS grid 行模板。

6. **三个面板各写一套行布局，互不对齐。** IssuePanel 用 `<table>`（`py-2`），SimpleList / TodoPanel 用 flex（`px-4 py-2` / `py-1.5`），padding、行高、列起始位置各不相同 → 切换面板时行的左缘和对齐会「跳」。修法：抽一套共享的「列表行 / 段头 / 工具栏」组件，用统一的 grid 列轨道（grid template），三面板复用——这也正好承接第 10 条。

7. **徽章自身的截断边界。** `Badge` 固定 `max-w-44`（`badge.tsx:64`），内部 `truncate` 是生效的（这点是对的），但窄面板下它仍与其它列竞争宽度，且多枚芯片叠加会触发第 3 条的换行。修法：芯片宽度参与第 4 条的整体空间预算，不要孤立设死值。

**一句话总结这层问题：** 现在是「固定像素列 + 失效的截断 + 可换行内容」三者叠加——宽时右侧留白尴尬、窄时标题被挤没、内容多时行高乱跳。正确姿势是「弹性主列（标题 flex-1 min-w-0）+ 可压缩/可隐藏的次要列 + 全部单行截断 + 统一 grid 行模板」，先把这套行布局地基打平，再谈分组、图标、时间线这些上层。

> 注：以上仅为方案，未动任何代码。请评审后告知优先级与取舍，再进入实现。

---

## 四、实现情况（round-5 已落地，`npm run typecheck` / `npm run build` 均通过）

一次性把上面的方案全部实现了。核心是先打平「行布局地基」，再在其上叠 Linear 功能。

### 新增的共享地基（解决第三节的结构性 bug）

- `src/renderer/components/collection/parts/layout.ts` — 全局行/段头/工具栏的样式常量（`ROW_BASE` 定高单行 grid、`PANEL_BAR`、`GROUP_BAR`）。四个面板统一用它，切换不再跳。
- 所有面板从 `<table>`/裸 flex 改为 **CSS grid 行**：标题列 `minmax(0,1fr)` 主导且 `min-w-0` 截断，次要列可压缩，内容一律单行、容器 `overflow-x-hidden`。截断/换行/撑宽/列倒挂的毛病一并消除（三.1~5）。
- `src/renderer/lib/view-prefs.ts` — localStorage 持久的视图偏好（分组/排序/升降序），display-only、不写 `.iris/`。

### 三个面板的具体改造

- `parts/StatusIcon.tsx` / `parts/PriorityIcon.tsx` — Linear 式状态进度环 + 优先级条形图标，颜色取自现有 badge 模板表（图标与徽章永远一致），未知软值降级。
- `parts/GroupHeader.tsx` — sticky 可折叠段头（chevron + glyph + 计数）。
- `parts/DisplayMenu.tsx` — 「显示」弹层：分组依据 / 排序依据 / 升降序。
- `IssuePanel.tsx`（重写）：分组（状态/优先级/工作区/标签/不分组）+ sticky 折叠段头；行首优先级图标 + 状态环（点击即改，复用 `setDocField`/`setDocStatus`）；文本搜索框；活动中/已解决/全部 + 工作区/标签过滤芯片；键盘（`j`/`k`/↑↓ 移动、`Enter`/`o` 打开、`x` 多选、`c` 新建、`Esc` 清空）；多选（hover 复选框 / `Ctrl`+点击 / `x`）+ 底部批量条（批量设状态、设优先级）。
- `StatusList.tsx`（新）：每篇 status 对比 `reflects:` 与 git HEAD，显示「最新 / 已落后 / 未标注」徽章（tooltip 给出两个短 sha）。HEAD 经新增的 `project:git-head` IPC 读取，失败静默降级。
- `ReportTimeline.tsx`（新）：按 今天 / 近7天 / 近30天 / 更早 分桶的时间线，sticky 段头，行首时间点 + 日期；「仅活动 / 全部」开关（Backlog 默认隐藏）。
- `SimpleList.tsx`（重写）：仅服务 misc，套用共享 grid 行。
- `MiddlePane.tsx`：issue→IssuePanel、status→StatusList、report→ReportTimeline、misc→SimpleList。

### 后端改动（最小）

- `src/shared/protocol.ts` 加频道 `PROJECT_GIT_HEAD`；`src/main/ipc.ts` 加 handler，`git rev-parse HEAD`（3s 超时、`windowsHide`），非 git 仓库 / 无 git / 无项目 → 返回 `{ head: null }`，纯只读，不碰红线。

### 已知取舍 / 未做满的点（评审时留意）

1. **status 时效只到「最新 / 已落后」**，未算「落后 N 个提交」——那需要对每篇 doc 跑一次 `git rev-list`，成本与复杂度高，先做等值判断。HEAD 在挂载时与窗口重新聚焦时刷新（提交后切走再回来即更新），不是实时。
2. **report 没有正文预览片段**——扫描结果 `IrisDoc` 不带 body，取片段要逐文件 `doc.read`，违背「轻量投影」，故时间线只用日期+标题+标签+状态，不读正文。
3. **折叠分组状态**用组件内 state（不持久化），避免动态键产生陈旧持久值；分组/排序/升降序则持久化。
4. **按标签分组**时一篇多标签 issue 会出现在多个分组（与 Linear 一致），无标签归入「无标签」桶。
5. 批量改值逐条经 `doc.save`（按 `doc:{path}` 串行），多选大量文件时是多次写盘。

## 五、手工测试流程

`npm run dev` 启动，打开本项目（`.iris/` 已有真实 issue/status/report）。

### A. 行布局地基（最该先验）

1. 进 Issue 面板，把中栏/左栏拖到**很窄**：标题应单行省略号截断，右侧图标/日期不被挤飞、无横向滚动条、行高保持一致（不因标签多而变高）。
2. 找一条标题很长、标签 ≥3 个的 issue：标题截断、标签只显示前 2 个 + 「+N」、整行仍是单行定高。
3. 在 Issue / Status / Report / Misc 间切换：行的左缘、行高、列对齐应一致、不跳动。

### B. Issue 面板功能

4. 点右上「显示」→ 切「分组：优先级 / 工作区 / 标签 / 不分组」，列表应即时重组；段头可点击折叠/展开、滚动时吸顶；计数正确。
5. 「显示」里切排序依据与升/降序，顺序随之变化；刷新页面后偏好保持（localStorage）。
6. 搜索框输入关键词：按标题/标签/文件名即时过滤；活动中/已解决/全部 计数随过滤更新。
7. 点行首**优先级图标**和**状态环**：弹出菜单改值 → 盘上 frontmatter 应被改写（去文件确认），列表经文件监听自动刷新。点标签芯片 → 进入标签过滤，再点清除。
8. 键盘：面板内点击一下取得焦点，`j`/`k` 上下移动高亮（自动滚动到可见）、`Enter` 打开、`c` 弹新建、`x` 选中当前行、`Esc` 清空选择。
9. 多选：hover 行左侧复选框点选，或 `Ctrl`+点击多行 → 底部批量条出现 → 「设状态 / 设优先级」批量改 → 去盘上确认多文件被改、选择清空。
10. 归档工作区里的 issue 应置灰且不可内联改值；frontmatter 损坏的行显示警告图标。

### C. Status 面板

11. 进 Status 面板：带 `reflects:` 且等于当前 HEAD 的显示绿色「最新」；`reflects:` 落后于 HEAD 的显示金色「已落后」（hover 看两个短 sha）；无 `reflects:` 显示「未标注」。
12. 在终端 `git commit` 制造一个新提交后，切走再切回（或窗口失焦再聚焦）：原本「最新」的应变「已落后」。
13. 非 git 仓库 / 没装 git 的项目：freshness 列安静降级（只显示短 sha 或不显示），不报错。

### D. Report 面板

14. 进 Report 面板：按 今天 / 近7天 / 近30天 / 更早 分桶，新→旧；段头可折叠；行首有时间点圆点 + 日期。
15. 「仅活动 / 全部」开关：`status: Backlog` 的 report 在「仅活动」下隐藏，「全部」下出现。

### E. 回归

16. `npm run typecheck`、`npm run build` 应通过（已自测通过）。
17. 打开任一文档再返回集合视图，零 diff 纪律不受影响（本次未碰编辑器/序列化路径）。

> 状态已置 `In Review`，等手工验收。验收意见或要调整的点写在下面即可。
