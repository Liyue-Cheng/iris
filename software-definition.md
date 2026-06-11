# 软件定义书 — Iris(待定名)

> 一个 AI 原生、文档中心、终端驱动的项目管理工具。它替代的不是 Jira,是 VSCode。
>
> 本文是**产品与协议**定义,不含实现细节;实现见《技术设计书》(technical-design.md)。

---

## 1. 定位

一个刻意做到最薄的项目管理外壳,套在一堆 markdown 文件和一池终端会话上,把所有智能外包给用户已经在用的 agent CLI,把所有数据留成纯文本。开源、零账号、零订阅、agent 无关。

在 AI 时代,编程本身就是项目管理:人不需要总盯着代码,等真要看时,代码编辑器已经在那。本工具就是"不用看代码时的那一层协调皮"。

**协议先行**:Iris 的本体是一个协议(`.iris/` 目录结构 + 一份散文宪法),不是应用。协议不需要应用在场就能运转——手建文件夹、贴上宪法、用裸终端即可工作。应用是协议的参考实现:查看器 + 召唤器。发布策略同理:先发协议规范,应用作为它的第一个实现。**协议的事实规范就是宪法模板(附录 B)**——agent 真正读到的只有它;定义书负责叙述与理由。

---

## 2. 设计原则

### 两个第一公民
文档(markdown)和终端(PTY)。其余设计围绕这两者展开——这是用来对齐方向的重心,不是演绎用的公理。

### 文件系统即数据库
所有项目数据以 `.md` 文件存在文件夹里。没有自有存储格式、没有数据库、没有云。git 即版本管理、即同步、即协作。数据比软件活得久。

### 确定性预算集中花在渲染层
渲染层按文件夹名和 frontmatter 字段,把 md 投影成对应视图。我们希望这一层保持确定性,因为用户信任界面是字面的;渲染层越可预期,其余部分就越敢于模糊。类型扩展沿同一思路:配置优先在确定性原语里**组合**,少做**计算**。

### 模糊优于精确
所有项目配置以提示词形式存在(写在宪法文件里),不是代码。**键是硬的**(渲染层按字面解析),**值是软的**(agent 按软规约填写)。名字是硬的,树形是自由的。

### 智能优于规范
"Types as lenses, not schemas":类型是导航透镜,不是强制校验。约束活在规范层,不在类型系统。宪法的简短是承重的:每多一条规则,所有规则的遵守率都在下降(context rot)。规范预算极其有限,只花在刀刃上。

### 哑壳 + 智能外包
应用本身近乎零智能。agent 能力来自用户本机已安装登录的 CLI(claude / codex / gemini / opencode / aider……)。App 默认不内嵌 agent、SDK 或 API key——智能外包是基本姿态,不是禁令。

### Agent 无关
任何输出 CLI 的 agent 都能用。本工具倾向于不解析 agent 的输出,而是监听文件——**文件才是契约**。这样新增一种 agent 几乎不需要适配代码。

### 尊重边界
Iris 自有的东西尽量住在 `.iris/`(项目级)和 `~/.iris/`(机器级)两个命名空间里,少打扰用户的项目根。删掉 `.iris/` 基本等于卸载 Iris,项目完好无损。

### Optional at every layer(每一层都可降级)
App 关了,文件夹还是好用的纯文本;`$FOCUS_DOC` 没被读,人补一句话就行;宪法被忘了,文档顶多放错位置;协议不要了,删掉 `.iris/` 项目毫发无伤。当一个新功能会让某层从"可选"滑向"必需"时,值得停下来多想一想——这是一个提醒回头看方向的信号,不是否决票。

---

## 3. 协议:数据模型

### 项目结构

```
my-project/
├── AGENTS.md                 # 项目级标准入口(非 Iris 拥有)。只追加一段引导。
├── .iris/                    # Iris 的项目级命名空间(根工作区)
│   ├── CONVENTIONS.md        # 宪法本体。手写一次。App 只读,agent 不许动。
│   ├── status/               # 当前真相。AI 实时维护。带 commit 戳。
│   ├── issue/                # 待处理的事和已知问题。
│   ├── report/               # 一次性快照,只追加归档。
│   ├── misc/                 # 人的草稿。系统外。
│   └── spike-auth/           # ← 一个子工作区(任意名字,内含类型文件夹)
│       ├── status/
│       ├── issue/
│       └── report/
└── (你的代码和其他文件)
```

### 一条递归规则:名字即类型

协议最承重的一条规则,递归生效:**叫 `status/`、`issue/`、`report/`、`misc/` 的文件夹,无论出现在 `.iris/` 树的任何深度,都按对应类型解析、渲染、分类。** 每篇 md 的类型由"最近的类型文件夹"决定。

### 工作区:推断,不声明

**任何包含了类型文件夹的文件夹,自动是一个工作区。** 没有注册表、没有 manifest——结构全部从文件系统本身读出。`.iris/` 根是默认工作区;子文件夹工作区用于独立探索、临时攻坚等子项目场景。

- **创建是人的手势**(走软件向导;模板:标准四文件夹 / 空自定义)。agent 未经要求不创建新工作区。
- **作用域(词法)**:agent 写回时,写到包含 `$FOCUS_DOC` 的**最近一层工作区**。`$FOCUS_DOC` 的路径同时编码了类型和作用域。
- **生死同域**:探索失败,删掉整个工作区文件夹一了百了;成功,把有价值的文档晋升到父级。
- **归档技巧**:把整个已结束的工作区挪进父级 `report/`——report 的契约是"冻结的过去",界面自动整体灰化。零新概念。
- **工作区级元数据**用一篇普通 `index.md` 放在工作区根上,目前不打算引入 manifest。

### 四种新鲜度契约

| 类型文件夹 | 时间语义 | 维护者   | 新鲜度契约               | git 合并表现        |
|------------|----------|----------|--------------------------|---------------------|
| `status/`  | 现在     | AI       | 必须等于现在(最强契约) | 最差(派生物,见 §6)|
| `issue/`   | 未来     | 人 + AI  | 有效直到被解决           | 良好(一事一文件)  |
| `report/`  | 过去     | AI       | 出生即冻结,只追加       | 完美(只增集合)    |
| `misc/`    | 系统外   | 人       | 无契约                   | 无关                |

**事件溯源读法**:`report/` 是只追加的事件日志,`status/` 是物化视图,`issue/` 是待处理队列。status 若失真,可由 report + 代码重建——report 是地面真相的沉积层,status 只是它的缓存。宪法要求 agent 每次完成工作往 `report/` 追加一篇会话日志("做了什么、为什么"),这同时构成项目的可检索机构记忆。

类型只规定语义,不规定内容清单:某个类型下具体有哪几篇文档、各覆盖什么,由人和 agent 在工作中协作形成,协议不预先规定。

### frontmatter 与命名约定

```yaml
---
title: 服务边界设计
status: in_progress           # 软规约推荐值,可偏离
reflects: a1b3c2              # agent 侧盖戳约定:本文反映哪个 commit(App 侧过期计算 v1 不做)
---
```

- **键**:按字面识别(`status:` 存在 → 任务视图;`reflects:` → 留给后续的过期计算)。
- **值**:agent 按宪法填,允许偏离。
- **文件命名**:`issue/` 与 `report/` 中新建文件带日期前缀(`2026-06-10-auth-refactor.md`),保证多人/多 agent 并发新建不撞名。

### 规约的作用域链

规约按"最近作用域优先"解析,从内到外:**工作区 ⊂ 项目 ⊂ 机器**。

**项目层** `.iris/CONVENTIONS.md`(进 git,团队共享)——描述**工作本身**的契约:文件夹语义、盖戳规则、写回作用域。凡是协作者解读这些文件时需要知道的东西,放在这一层。

**机器层** `~/.iris/CONVENTIONS.md`(不进 git,跟机器走)——描述**工作发生的环境**:本机事实清单。主体是 Environment 一节:公司加密软件(名称、干扰方式、白名单目录、绕法)、网络代理、虚拟机/真机、资源限制、权限、工具链怪癖。品味偏好放末尾当附注。

- **归层试金石(可移植性)**:"换一台机器这句话就不成立"→ 机器层;"在任何机器上 checkout 都必须成立"→ 项目层。
- **写法纪律**:写事实,别写规则。事实老化慢、agent 怎么用都行;规则会打架、更吃预算。
- **为什么值得**:环境怪癖是 agent 误诊的头号来源(加密软件悄悄损坏构建产物 → agent 反复"修"一个不存在的 bug)。这层把灵异故障变成预期行为。同时它是泄压阀:机器噪声留在本地,项目宪法保持干净;代理地址、内网工具名等半敏感信息天然不进 git。
- 一个资深工程师脑里装着两种知识:关于项目的、关于这台机器的。项目层外化前者,机器层外化后者——agent 两者都读,才像"在这台机器上干过活的人"。

`~/.iris/` 与 `.iris/` 同构地各有两类公民:**CONVENTIONS.md 给 agent 读(协议的一部分);settings / templates 给 App 读(软件配置)。** 各读各的,谁也不解析谁。

### 宪法的注入链与版本

根 AGENTS.md(一段引导)→ `.iris/CONVENTIONS.md` → `~/.iris/CONVENTIONS.md`(若存在)。三跳,每跳有遵守率衰减,所以机器层最好是三份里最短的,项目宪法也值得刻意写短。宪法 frontmatter 带 `protocol: 1` 版本号:协议升级倾向于留给人的手势——软件检测到旧版只**提示** diff,不代改。

---

## 4. 交互模型

核心动词:**选中文档 → 右键 → 用 X 打开**。

- 新开一个终端会话,工作目录为项目根,环境变量 `FOCUS_DOC=<被选中文档的相对路径>`,**裸启动** agent(不传任何 prompt)。
- agent 按注入链读宪法 → 按协议读 `$FOCUS_DOC` → 上下文到手 → **停住等用户指令**。打开 ≠ 开跑:没有 user message 就没有任务。
- 动态聚焦走环境变量(随进程生、随进程死),静态契约走宪法文件——两个生命周期,两条管道,各走各的。
- 价值重心在这个手势上:它消灭"每次开 agent 手动粘贴上下文"的摩擦。

### 会话模型:多会话,detach 而非 dispatch

- **一个项目下同时多个会话是常态**:一个挂在架构文档上,一个挂在某 issue 上,一个挂在项目根。会话锚定于文档;根目录会话为无聚焦兜底。
- **锚定模型借鉴 Marina**(路径↔会话 → 文档↔会话):绑定在会话创建时确定、终生不变;**一篇文档可同时挂任意多个会话**(比如 claude 和 codex 各开一个)。会话中途想换聚焦文档,人在对话里直接说一句就行——协议不为此加机制。
- **会话是工作记忆,文档是长期记忆**:会话便宜、可死、可重开;文档永久,通过写回沉淀每个会话的产出。一篇文档一生被多个会话服务,会话死了,文档记得。
- **detach,不 dispatch**:当前不做 headless 派发。会话保持交互式、对话式,人只是不被锁在窗口前——离开、回来、接上。agent 的提问停在"等待输入"态被亮出来。吞吐靠并行多会话获得,对话控制面一点不交出去;所有 agent 动作都发生在人类拥有、必然回访的对话里,审查点始终存在。

### 冷启动

不需要专门功能。脚手架建好后,对项目根开一个会话说一句"读这个代码库,按 `.iris/CONVENTIONS.md` 生成初始 status 文档并盖 HEAD 戳"——协议自举。向导级 onboarding 留待后续。

---

## 5. 界面

三栏:

- **左栏**:按透镜组织的文档树——工作区为分组层级,组内按类型分类。issue 栏展开只显示**活动中**的 issue,已解决的不占视野。**每篇文档旁有会话状态点**(● 工作中 / ◐ 空闲或等输入):左栏即注意力调度面板,告诉人"哪件事在等你"。裸文件树是 toggle 出的逃生舱。
- **中栏**:两个层级。**点类型栏标题 → 类型级集合视图**:issue 是重头戏——Linear 风格的管理面板,在这里处理所有 issue(列表起步,可扩展看板视图);其余类型从简,一行一文件的列表。**点单篇文档 → 单篇视图**:类型化头部(徽章、字段)+ 正文,Typora 式所见即所得编辑,另有源码模式作精确编辑的逃生舱;**frontmatter 不进正文编辑器**,由头部拥有。
- **右栏**:垂直 AI 对话面板。点左栏文档即切到它的会话;一篇文档可挂多个会话时,右栏含会话列表与切换。

**状态点的判定**走 PTY 输出活动启发式:近期有输出 = 工作中,静默超过阈值 = 空闲/可能在等输入。只看字节流的有无,不解析内容。成熟做法直接借鉴 Marina:静默阈值(默认 2s)+ 几个防闪烁的静默窗口(启动期 / resize 回声 / 按键回显)。

**后续方向(v1 不做)**:过期标签——`reflects` 戳与 HEAD 比对,绿/琥珀/红分级,既给人看也给 agent 当信任校准信号(读到大偏移就把文档降级为弱先验、动手前先核对代码)。agent 侧的盖戳约定保留,App 侧的比对与渲染延后。

### 类型扩展:后续方向(v1 不做)

v1 只有四个内建类型。自定义类型(如学习笔记 `note/`)的方向已经想清楚:**语义 + 投影**两半分治——语义在宪法里用散文定义契约(零代码,智能外包白送);投影用声明式配置(`types.yaml`)在硬编码的渲染原语里**组合**,不做插件系统、不动态加载用户代码(用户天天 clone 陌生仓库,仓库内可执行代码 = 打开即执行陌生人代码;真需自定义逻辑走 fork,好的新视图原语走 PR 回流)。另记一条预算提醒:配置让类型对 App 变便宜,但类型对 agent 不便宜——每个自定义类型都要在宪法里花一段契约,四内建 + 一两个自定义大概是健康的量级。

---

## 6. 多人协作(经由 git)

协议在 git 多人下成立,且四类文件夹的合并表现与新鲜度契约成反比(契约越强,合并越疼):

- **report/**:只增集合,几乎不冲突;日期前缀基本保证不撞名。
- **issue/**:一事一文件,新建互不干扰;同一 issue 的 frontmatter 冲突小、可读、且暴露的是真实的人类分歧——让它冒出来是对的。
- **misc/**:各写各的。
- **status/**:**派生物不合并,只重建**(lockfile 范式)。merge 后喊一句"代码刚合并,重刷受影响的 status 文档"。
- **自愈兜底**:即使没人重刷,宪法的信任校准规则也要求 agent 把可疑的 status 当弱先验、回代码验证(后续有过期标签后,这一步会更自动)。系统不会因偷懒而错,只会暂时变慢,然后自愈。
- **边界**:git 只解决异步协作;同时改同一篇靠分支纪律(和代码一样)。多人下最先咬人的是惯例漂移(一人 `wip` 一人 `in_progress`),解药是宪法进 git——多人协作不需要新设计,只是让已有机制变得更重要。

---

## 7. 当前不做什么(取舍,非教条)

以下是当前阶段的取舍,记录的是方向感和理由,不是身份认同。哪条的理由不再成立,就重新讨论那一条。

- 不内嵌 agent、SDK、API key——用户自带 CLI、自带计费,壳保持哑。
- 不做账号、订阅、云、遥测——数据留在用户手里。
- 不主动打扰项目根;不持续维护根 AGENTS.md。
- 不做 headless 派发——detach,不 dispatch,对话控制面留给人。
- 暂不做插件系统——视图扩展走声明式配置;真需自定义逻辑 = fork / PR。
- 不做笔记 vault(Obsidian / Tolaria)、会话编排看板(Vibe Kanban 类)、代码编辑器——别人已经做得很好的,不重做。
- 不解析 agent 输出——文件才是契约。
- 不做 schema 校验、不给工作区加 manifest——约束留在规范层。
- 不代写宪法(两层宪法均为用户手写,App 只读)。
- v1 不做多项目管理——一次打开一个项目。

---

## 8. 开放问题(产品/协议级)

- **命名**:`.iris/` 为占位,定名后全局替换;这个名字会出现在所有用户项目里。
- **散文规约的测试**:宪法没有测试套件,坏了只有沉默的违约。可能的方向:"宪法 CI"——固定剧本 × 每个支持的 agent,改措辞即回归。产品的"代码"一半是 prose,prose 也需要回归测试。此领域无前人经验。
- **注入面**:`.iris/` 是所有 agent 共读的外部记忆,被污染的文档可能携带注入指令。当前交互模型(detach、人必回访)使风险可控;若未来引入任何低监督运行形态,需先有应对方案。
- **协议升级**:宪法用户拥有,软件不代改。靠 `protocol: 1` + 提示 diff、人工合入。

---

## 附录 A:根目录 AGENTS.md 中追加的引导段

````markdown
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
````

## 附录 B:`.iris/CONVENTIONS.md`(项目宪法模板)

````markdown
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
````

## 附录 C:`~/.iris/CONVENTIONS.md`(机器层模板)

````markdown
# Machine Conventions (this machine only — not in git)

## Environment facts

State **facts**, not rules. Keep this file the shortest of the three.

- Encryption: this machine runs <NAME> transparent file encryption.
  Files created outside whitelisted dirs (<DIRS>) get silently
  encrypted; corrupted-looking build artifacts are usually this, not
  your code. Workaround: <HOW>.
- Network: outbound traffic requires proxy `http://127.0.0.1:<PORT>`;
  npm/pip use mirrors <URLS>.
- Machine: corporate VM; snapshots nightly — `/tmp` does not persist.
- Resources: 8 GB RAM — do not run the full test suite in parallel.
- Permissions: no sudo on this box.
- Toolchain: node via nvm; system python locked at 3.9.

## Personal preferences (optional, keep short)

- Write issue/report documents in Chinese.
````
