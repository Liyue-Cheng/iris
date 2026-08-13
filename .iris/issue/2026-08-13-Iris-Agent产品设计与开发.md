---
title: Iris Agent 产品设计与开发
status: In Progress
---

## Issue 定义

Iris 要开发一个内置 Coding Agent。它不是把现有 CLI 塞进 GUI，也不是重新实现通用自治 Agent 平台，而是利用 Iris 已有的 Issue、文档、右栏 Session 和真实终端，建立一个同步、透明、可 Fork、可有限 Rewind 的工程执行环境。

本 Issue 是 Iris Agent 最新产品规范、系统边界、实施顺序和自举准入标准。后续实施进度、验收结果和新的有效结论继续写回本 Issue；旧方案、讨论过程和已经被替代的设计不在这里保留。

## 要解决的问题

现有 Coding Agent 经常用单条聊天记录同时承载对话、任务、终端、上下文、进程和项目记忆。长任务、上下文压缩、工具失败和用户并行工作一旦出现，真实状态就会被摘要、截断或隐藏。

Iris Agent 直接解决以下问题：

* 用户看不到 Agent 使用的完整真实终端，无法核对模型判断；

* 长命令被建模成反复等待、后台通知或隐式异步，破坏因果关系；

* 模型实际收到的 software prompt、项目提示词、anchor、历史裁剪和工具 schema 不可审计；

* Session 被迫承担项目长期记忆，既沉重又难以组织多条执行路径；

* Fork 与 Rewind 容易制造“外部世界也被复制或回滚”的错觉；

* 工具错误只存在于日志或摘要，界面和模型看不到完整原因；

* 子 Agent、沙箱和复杂权限系统扩大状态空间，却不服务当前目标。

## 产品目标

1. 让 Issue 成为持久工作对象，让 Session 成为 Issue 下可创建、Fork、结束和删除的薄执行上下文。
2. 让文件修改、终端、实际请求上下文、diff 和错误链可以被用户直接观察和追溯。
3. 保持单 Session 严格同步，用 20 秒隔离监督支持长命令。
4. 通过用户显式新建或 Fork Session 提供并行路径，不允许模型隐藏委派。
5. 分阶段提供 Rewind：关键里程碑一只 Rewind 消息记录；关键里程碑二增加消息与 Iris 受管文件的 Rewind。
6. 在全部核心门禁通过并经用户确认后，允许 Iris Agent 自举开发 Iris。

## 产品原则

### Issue 是顶层工作对象

Issue 保存问题、目标、约束、已确认决策、当前进度、待办和最终结论。Session 只保存一段局部推理与执行过程。值得长期保留的信息必须回到 Issue、status、report、代码、测试或 Git，不能只存在于聊天历史。

一个 Issue 可以锚定多个执行主体：

```text
Issue
  |- Iris Agent Session A：调查
  |- Iris Agent Session B：实施
  |- Iris Agent Session A'：从 A 的完成节点 Fork
  |- 外部 Agent CLI Session
  `- 普通终端 Session
```

Session 结束不改变 Issue 状态，Issue 状态变化也不伪造 Session 结果。两者生命周期相关但不等价。

### Session 是薄执行上下文

Iris Agent Session 拥有：

* 固定的 Issue、文档或 workspace hub anchor；

* 当前线性对话记录；

* provider、模型和必要配置；

* 尚未完成的模型请求或工具调用；

* 它自己创建的真实终端；

* Iris 受管 `edit`、`write` 修改记录；

* 父 Session 和 Fork 节点。

普通 Terminal Session 与 Iris Agent Session 使用不同的数据聚合和生命周期，只在右栏共享带 `kind` 的统一投影。现有以活 PTY 为核心的 `SessionManager` 不直接承担 Agent 的持久历史。

Session 元数据、历史、请求事实和终端记录属于 App 本机数据，不写入项目 `.iris/`。应用重启可以恢复历史，但不能伪装已经终止的 Worker 或 PTY 仍在运行。

### 单 Session 严格同步

一个 Session 内始终只有一条因果链。terminal tool call 未完成时，Agent loop 不得继续后续步骤。系统不建设通用后台任务图，也不让 Agent 在等待期间自行切换任务。

用户需要同时处理另一件事时，显式新建或 Fork Session。并发是人的注意力结构，不是模型隐藏创建的任务结构。

### 原始事实优先于摘要

真实文件、真实 diff、实际 provider 请求、完整终端和结构化错误是事实源。聊天中的紧凑工具事件只是入口。任何压缩、裁剪、重试和错误转换都必须可检查，不能静默改变用户和模型对现实的理解。

## 产品交互

### 两级导航

右栏顶部选择条切换执行主体；Iris Agent 内部标签切换该 Agent 拥有的工作面。

```text
当前 Issue / 文档
  -> 右栏顶部 Session 选择条
     |- Iris Agent A
     |   |- [Agent]
     |   |- [Terminal: vivado]
     |   `- [Terminal: npm test]
     |- Iris Agent B
     |   `- [Agent]
     |- Claude / Codex
     `- 普通终端
```

右栏没有 Session 时，启动列表第一项是“用 Iris Agent 打开”。打开后，Iris Agent 以 `iris-agent` kind 出现在现有顶部选择条中。切换右栏 Session 不改变中间文档。

### Agent 页面

新 Agent 初始只有固定的 `Agent` 标签。默认历史显示：

* 用户消息；

* Agent 最终回答；

* 必要的文件读取与修改摘要；

* 短命令及最终结果；

* 长命令的终端引用与最终状态；

* 异常判断和用户决策。

模型推理时显示实时状态，结束后不在历史中保留“思考 X 秒”。Token、费用、provider retry 和监督调用属于按需诊断信息，不占用默认历史。

流式回答提供“停止生成”，运行命令提供“中断命令”。Session 菜单分别提供“结束运行”“归档”和“删除历史”。右栏关闭按钮不直接删除持久 Agent Session。删除必须确认，并明确本地历史、终端记录和受管修改记录会被删除；删除不撤销项目副作用。

### Agent Terminal

每个 terminal tool call 创建一个独立 PTY，直接运行一条命令。进程退出即 tool call 完成，不在命令结束后重新进入交互 shell。

Agent Terminal 属于对应 Iris Agent Session，不属于 Issue，也不作为独立 Session 出现在右栏顶部选择条中。

* 3 秒内结束的命令只记录命令、退出状态和精简结果；

* 超过 3 秒仍在运行的命令，在当前 Agent 内增加 Terminal 标签并自动切换；

* Terminal 从第一个字节重放同一个真实 PTY 的完整输出；

* 用户主动切回 Agent 后，后续输出不能再次抢走焦点；

* 已结束 Terminal 标签可以关闭，但工具历史与终端记录不会因此消失；

* 切换到另一个 Agent 时，只能看到另一个 Agent 自己的内部标签。

MVP 的 Agent Terminal 只读，不接受用户键盘输入；需要交互输入的命令必须终止并向模型和 UI 返回明确的不支持错误。关键里程碑二允许用户直接操作同一个 PTY，tool call 继续同步等待。用户输入只记录是否发生和字节计数，不持久化明文键盘内容；工具结果标记用户参与事实。

完整终端输出按 chunk 持久化，Session 未删除前可从第一个字节查看。实现每命令和全局软配额；接近上限时明确告警，达到硬上限时停止命令并返回 `OutputLimitExceeded`，不能静默截断后继续声称记录完整。具体额度由 PTY spike 确定。

### Fork

只能从已完成的历史节点 Fork。Fork 创建新的 Iris Agent Session，复制该节点之前的线性对话前缀、原 anchor 和必要模型配置。原 Session 保持不变，新 Session 出现在右栏顶部选择条中。

Fork 不复制：

* 正在运行或已经结束的终端；

* PTY、进程句柄和终端标签；

* 未完成的模型请求或工具调用；

* 受管文件修改记录的所有权；

* 工作区、Git、网络或其他外部副作用。

Fork 后重新读取当前真实磁盘。产品不建设常驻大型分支图，也不把候选回答 regenerate 与 Fork 混为一谈。

### Rewind

Rewind 只允许在 Session 已停止、没有进行中模型请求或工具调用时执行，目标只能是所有工具均已结算的完成节点。Stop 与 Rewind 是两个独立动作。

关键里程碑一只提供消息记录 Rewind：截断所选节点之后的当前对话，使后续请求从该节点继续。它不撤销文件、工具、终端或任何外部副作用，执行后重新读取真实磁盘。确认界面明确提示“只回退消息记录，工作区保持不变”。产品不提供被截断后缀的恢复或分支管理功能。

关键里程碑二采用与 Claude Code 相同的单次选择交互，提供两个选项：

* 仅 Rewind 对话；

* Rewind 对话和 Iris 受管文件。

“对话和文件”只撤销目标节点之后由当前 Session 的 Iris `edit`、`write` 工具产生的修改。执行前展示消息范围、文件清单和不支持的副作用，并预检所有文件的当前 revision。存在外部变化时，在写入前整体停止。

预检通过后按修改的反向顺序恢复文件。每个文件使用原子替换，但不承诺跨文件物理原子。中途 I/O 失败时停止，展示每个文件的真实状态，不移动消息位置；再次执行时可以识别已经恢复的文件并继续剩余文件。只有全部文件恢复成功后才截断消息。

即使选择“对话和文件”，也不回滚 terminal、formatter、codegen、Git、网络、数据库、部署、进程或其他副作用。Fork 不自动触发 Rewind，Rewind 也不删除 Session。

## Provider 与 Agent 引擎

### Pi SDK

Pi SDK 是可替换 Agent 引擎：

* Pi SDK 负责 provider、认证结果读取、流式协议、Agent loop、tool-call 协议、retry、基础 token/context 计算、可选 compaction 和 Agent 默认提示词基线；

* Iris 负责 Issue、Session、prompt assembly、工具托管、PTY、长命令监督、Fork、Rewind、GUI、持久化和可观测性；

* Pi RPC 只作为行为验证和兼容参照，不作为正式运行时；

* 不 fork Pi TUI 或完整产品；只有公开 SDK 明确阻塞必要语义时，才评审最小补丁 fork。

所有 Pi API 只能从窄 adapter 进入 Iris。版本精确锁定，不引用未承诺的内部 `dist` 路径。升级必须先通过 adapter contract tests 和真实 provider smoke。

### Provider 顺序

MVP 不重新实现登录。用户先在 Pi TUI 中完成登录或 provider 配置，Iris 通过 Pi SDK 复用其认证与配置结果。凭据不进入 Renderer、项目文件、Context Inspector 或普通日志。

关键里程碑一只要求通过该机制跑通至少一个真实 provider 和模型。

关键里程碑二必须完成多 provider，并覆盖 Pi SDK 所支持和配置的全部 OpenAI-compatible provider。选择、切换、能力判断和错误展示使用统一 OpenAI-compatible adapter 语义。

Anthropic Messages 等非 OpenAI-compatible 协议族，以及 Iris 内置的完整登录、登出和凭据管理 UI，推迟到关键里程碑二之后。

### Agent Worker

每个正在运行的 Iris Agent Session 拥有一个懒启动的独立 Worker。空闲 Worker 可以退出，下次发送时从持久历史重建。Worker 崩溃只能使对应 Session 失败，不能拖垮编辑器、普通 PTY、Git 或其他 Session。

Worker 只持有 Pi adapter 和当前运行状态，不拥有项目文件、PTY、Session 真相或可展示的凭据。Renderer 不直接调用 Pi、provider、文件系统或 node-pty。

## Prompt、Anchor 与请求一致性

### Agent 专属基础提示词

Iris Agent 不重新设计一套通用 Coding Agent 提示词。Agent 专属基础提示词直接以上游 Pi 对应锁定版本的默认提示词为基线，只做 Iris 宿主所需的最小适配：

* 将 Pi 的产品名和自我指代改为 Iris Agent；

* 将上游工具名、参数说明和能力描述映射为 Iris 实际暴露的 `read`、`edit`、`write` 和 `terminal`；

* 将终端、工作目录、项目边界和运行环境描述改为 Iris ToolHost 的真实行为；

* 删除或改写 Iris 未启用的 TUI、extensions、项目 `.pi/`、subagent、permission、sandbox 和其他能力；

* 保留 Pi 默认提示词其余行为约束和工作方式，不额外加入 Iris 自创的人格、编码哲学或通用工作流程。

这份提示词是独立于 Iris software prompt 和 project prompt 的版本化内置资源。它不从 Pi TUI 配置、项目文件或外部 CLI 镜像动态读取，也不把 `<iris-software>` 协议内容复制进自身。

每个版本必须记录上游 Pi 精确版本、上游提示词 fingerprint、Iris 适配 patch 版本和最终 fingerprint。升级 Pi 时先对比上游提示词变化，再重放并审查最小适配；不能在升级中静默继承旧文案或扩大 Iris patch。若 Pi SDK 提供稳定的公开 prompt builder/override API，优先通过该 API 应用适配；否则在许可证允许的前提下内置锁定版本的上游文本及最小修改，并纳入第三方声明。

### Canonical 来源

内置 Iris Agent 直接读取 canonical sources，不从外部 CLI 镜像倒读提示词：

```text
Pi 默认 Agent prompt 基线 + Iris 最小适配 + version/fingerprint
App 内置 software prompt + version
.iris/settings.json / prompts.project + revision
固定 Session anchor
发送前 flush 后的最新 Issue/文档快照 + revision
当前 Session 对话历史
Iris tools schema + version
```

* Agent 专属基础提示词的真相源是 App 内置、版本化的 Pi 基线及 Iris 最小适配；

* `<iris-software>` 的真相源是 App 内置模板；

* 项目提示词的真相源是 `.iris/settings.json / prompts.project`；

* `AGENTS.md`、`CLAUDE.md` 等受管块只是外部 CLI 的单向投影；

* vendor 镜像漂移属于 prompt health，可以阻断对应外部 CLI，但不阻断直接读取 canonical prompt 的内置 Agent。

### 固定 Anchor

Session 创建后 anchor 固定，不随中间选中文档变化。文档 Session 锚定具体文档；Hub Session 锚定创建时的 workspace/root，并在没有具体任务时等待用户指令。

文档 anchor 被移动、删除或变为不可读时，不自动 re-anchor。Session 进入 `anchor-missing`，保留原身份；用户只能显式从新 anchor 创建或复制 Session。

每次正式发送前必须：

1. flush 固定 anchor 的编辑器内容；
2. 从磁盘读取最新内容和 revision；
3. 按固定顺序组装请求；
4. 保存实际发送层的 revision、fingerprint 和规范化内容；
5. 再发起 provider 请求。

flush 失败、renderer 无响应、编辑冲突或 anchor 变化时阻断发送，并展示具体原因；不能提供“仍然发送旧快照”的捷径。Hub Session 不执行文档 flush，但仍捕获 workspace、project prompt 和扫描 revision。

## Iris ToolHost

第一组工具是 `read`、`edit`、`write` 和 `terminal`。工具 schema、参数语义、结果形状和文本编辑行为直接沿用 Pi 的公开实现，不另行设计一套 Iris 专用文件工具协议；在引入代码时完成许可证与第三方声明审计。

Pi 工具实现外包一层 Iris main ToolHost：

* 强制 project scope、project generation 和项目内路径边界；

* 保留 Pi 的工具行为和模型兼容性；

* 文件写入仍由 Iris main 执行，成功前后记录足以生成 diff 和支持完整 Rewind 的内容与 revision；

* terminal 只通过 Iris main 创建可见的独立 PTY；

* 每次调用绑定 Session、turn、tool-call 和 correlation ID；

* Worker 不能直接写文件或启动 Iris 不可见的命令。

watcher 只负责刷新 UI 投影，不作为写入成功的判据。工具错误必须以完整结构化结果同时到达模型和 UI。

## 长命令监督

长命令始终是当前 Agent loop 中未完成的前台 terminal tool call。Iris 每 20 秒按游标读取新增输出，并用当前 provider/model 发起隔离的临时监督调用。

监督调用只获得固定监督规则、命令元数据、必要重叠日志、增量输出和进程状态；它不能执行工具，也不能继续主任务。

* 输出正常时立即丢弃监督结果，不写入 Session 历史或后续主上下文；

* 没有新增输出时可以不调用模型；

* 发现可疑情况时停止后续监督调用，立即向用户展示依据并请求继续观察或终止；

* 监督异常不会尝试跨平台 suspend，命令继续运行，UI 必须明确显示“进程仍在运行”；

* 只有用户可以发送 interrupt 或 terminate；

* 命令结束后只向主 Agent loop 返回一次最终结果。

临时监督产生的真实 usage 进入诊断事实，但不制造周期性聊天记录。

## 数据、持久化与生命周期

Iris main 是 Session 元数据、消息、请求事实、工具副作用、终端归属和本地持久化的权威。Renderer 只是可重建投影。

本地 Session 至少表达：

```text
IrisAgentSession
  id
  kind
  projectIdentity
  anchor
  parentSessionId
  forkEntryId
  modelConfig
  lifecycleState
  activeRequest
  terminalRuns
  managedMutations
  schemaVersion
```

项目身份使用 canonical absolute root 的 hash 建本地 namespace，并保存原路径。项目整体移动后不自动猜测关联；未来通过显式重新关联功能处理。

同一项目同时在两个窗口打开原则上不受支持，本 Issue 不定义 Agent Session 的跨窗口一致性行为。后续应把同一项目的重复打开收敛到已有窗口。在该能力完成前，相关场景不属于 Iris Agent 的支持和验收范围。

应用重启后恢复 Session、消息、脱敏请求事实、工具事实和已保存终端输出。原来处于 `starting`、`running` 或 `waiting-tool` 的状态统一恢复为 `interrupted`；后续发送启动新 Worker 并从当前消息记录重建，未完成工具不自动重放。

项目切换、窗口关闭、停止生成、中断命令、结束运行、归档和删除历史分别建模。取消模型请求、终止工具和终止 PTY 不是一个模糊的 stop 操作。

### 请求事实与 Compaction

从关键里程碑一开始保存脱敏后的实际规范化 provider 请求、响应事件、usage 和上下文层 fingerprint。授权头、凭据和疑似 secret 字段在落盘前按结构化字段剔除，不能事后依赖字符串替换。

原始消息和工具事实不被 compaction 覆盖。上下文超限时生成派生 summary，记录覆盖的消息范围、模型配置、token 信息和裁剪事实。消息 Rewind 后被截断的内容不作为可恢复聊天分支暴露给产品。

### 关键失败语义

* provider 流中断：保留已接收事件和错误链，不生成完成节点；

* renderer reload：从 main 和本地 store 重建，不由 renderer 内存判断请求状态；

* Worker 崩溃：当前 turn 标为 `interrupted`，未完成工具不自动重放；

* 工具已在 main 成功但 Worker 未收到结果即崩溃：保留工具事实，不自动重复副作用；

* terminal 在 3 秒阈值附近退出：由 main 的同一状态机串行决定标签和最终结果，不能重复完成；

* 本地 store 损坏：从主文件、备份和 schema 校验分层恢复，不能静默生成空 Session；

* 完整 Rewind 遇到外部修改：在写入前停止并展示冲突；

* 完整 Rewind 中途失败：保留真实文件状态和原消息位置，允许重试未完成部分。

## 可观测性与安全边界

默认界面保持精简，但以下事实必须按需可达：

* 最终发送给 provider 的脱敏规范化消息；

* software prompt、project prompt、anchor、历史、工具 schema、compaction 和裁剪；

* 每个上下文层的来源、顺序、revision/fingerprint、发送状态和 token；

* 工具原始参数、结构化结果、完整错误、文件 diff 和关联终端；

* provider、模型、请求状态、retry、usage 和错误链；

* Worker、turn、model request、tool call、mutation 和 PTY 的统一 correlation 链；

* 从命令启动开始保存的完整终端输出。

任何影响用户意图或数据可信度的失败都必须到达 Agent 页面或对应事实视图，不能止于 `console.warn`、floating Promise 或截断摘要。

Worker 隔离是可靠性边界，不是安全沙箱。本 Issue 不实现沙箱、网络限制、普通命令审批或通用权限礼仪。Agent 文件与命令能力和本机当前用户一致，但所有 Iris 工具仍受项目路径边界约束。

## 明确不做

除非以后重新作出产品决策，本 Issue 不包含：

* 子 Agent、模型自动委派和后台多 Agent 编排；

* 单 Session 内绕过因果顺序的通用异步任务图；

* 沙箱、网络访问限制、普通命令审批和权限礼仪；

* Agent Terminal 作为 Issue 级独立 Session；

* 消息 Rewind 后缀恢复、聊天分支管理或常驻大型分支图；

* 正常监督、思考时长和 provider 内部事件进入默认历史；

* Fork 复制终端、进程、工作区或其他外部状态；

* Rewind 回滚 terminal、Git、网络、数据库、部署或其他非受管副作用；

* 默认加载 Pi TUI、extensions、subagent、permission、sandbox 或项目 `.pi/` 配置；

* fork Pi TUI、RPC 或完整产品；

* 用聊天卡片或模型摘要替代真实终端、diff 和项目文档；

* 当前阶段支持同一项目的多窗口 Agent 一致性。

## 开发阶段

开发分为四个阶段。关键里程碑一只证明入口、事件链和消息 Rewind 成立；关键里程碑二才允许自举。

### 第一阶段：Pi 与运行时验证

目标是消除引擎、认证复用、Worker、工具和 PTY 的关键不确定性，不建设正式产品 UI。

* [x] 精确锁定 Pi SDK 版本，确认公开 API、异常类型、许可证和运行时依赖。

* [x] 定位该版本 Pi 默认 Agent 提示词的公开来源、组装 API、fingerprint 和许可证边界。

* [x] 形成仅包含产品名、工具、运行环境和禁用能力的 Iris 最小提示词适配，并记录可审计 diff。

* [x] 验证读取并复用用户在 Pi TUI 中完成的登录与 provider 配置结果。

* [x] 用至少一个真实 provider 完成流式回答、tool call、取消、错误和自然结束 spike。

* [x] 确认 Electron/Node 要求和可随安装包交付的 Worker runtime。

* [x] 验证一运行 Session 一懒启动 Worker，Worker 退出后可从持久历史重建。

* [x] 关闭 Pi TUI、extensions、项目 `.pi/`、默认上下文发现、subagent、permission 和 sandbox。

* [x] 验证 Pi `read`、`edit`、`write`、bash/terminal 的公开实现可以被 Iris ToolHost 复用和包装。

* [x] 验证稳定完成节点、指定节点历史截断、Fork 前缀复制和上下文重建。

* [x] 验证 canonical prompt、固定 anchor、发送前 flush 和最新文档快照可以直接组装。

* [x] 验证最终请求按固定顺序包含 Pi-derived Agent 基础提示词、Iris software prompt、project prompt 和 anchor，且各层边界可区分。

* [x] 验证独立命令 PTY、3 秒显示阈值、完整磁盘输出、增量游标和单次最终结果。

* [x] 验证临时监督调用不进入正式 Session 历史。

* [x] 定义 Worker、Session、request、tool、terminal 和 correlation 的版本化协议。

第一阶段退出条件：

* [x] Pi 公开 SDK 足以支撑 Agent loop、TUI 认证复用、自定义 ToolHost、临时监督和历史截断，或确切阻塞点已经形成最小 fork 评审结论。

* [x] Iris 可以完全控制 prompt、工具副作用、PTY、持久化和 Session 产品语义。

* [x] Worker runtime 与安装交付方式已经确定。

* [x] 正式方案不依赖 Pi 未承诺的内部 `dist` 路径。

* [x] Agent 基础提示词的上游版本、最小适配、许可证处理和升级方法已经确定。

### 第二阶段：MVP 与关键里程碑一

目标是先让 Agent UI 第一次打开，再完成单 Issue、单 Session、非交互短任务的真实闭环。MVP 完成后仍不允许自举。

#### 基础运行骨架

* [ ] 实现独立 Agent Worker、版本化 IPC 和窄 Pi adapter。

* [ ] 实现 Worker ready、停止、崩溃、超时和清理状态机。

* [ ] 实现本地 IrisAgentSession store、schema 校验、备份和重启恢复。

* [ ] 为 Session、turn、model request、tool call 和 terminal run 分配稳定 ID。

* [ ] 实现实际请求事实的发送前脱敏与持久化。

* [ ] 内置版本化的 Pi-derived Agent 基础提示词及 Iris 最小适配元数据。

* [ ] 在 Iris main 实现包装 Pi 工具的最小 ToolHost。

* [ ] 让 terminal tool 通过 Iris main 创建独立 PTY 并持久化完整输出。

#### 关键里程碑一：Agent UI 第一次打开

* [ ] 在右栏空状态启动列表第一项加入“用 Iris Agent 打开”。

* [ ] 增加 `iris-agent` Session kind，并接入现有右栏顶部选择条。

* [ ] 实现初始只有固定 Agent 标签的 IrisAgentView。

* [ ] 从真实 Issue 或 hub 打开 Session，通过 Pi TUI 登录结果完成一次真实 provider 流式对话。

* [ ] 检查实际请求，确认使用锁定 Pi 版本的 Agent 基础提示词且只包含批准的 Iris 最小适配。

* [ ] 实现实时思考状态、流式正文、停止生成、失败和重试。

* [ ] 默认历史只显示用户消息、最终回答和紧凑工具事件。

* [ ] 为完成 turn 分配稳定节点，并实现仅截断消息记录的 Rewind。

* [ ] Rewind 前要求 Session 已停止，确认界面明确显示“只回退消息记录，工作区保持不变”。

* [ ] Rewind 后不提供旧消息后缀恢复或分支管理，下一次发送重新读取当前工作区。

达到关键里程碑一只说明入口、事件链和消息 Rewind 成立，不能宣布具备完整 Rewind、可用或自举资格。

#### MVP 最小工作闭环

* [ ] 创建 Session 时固定 Issue、文档或 hub anchor，并处理 `anchor-missing`。

* [ ] 实现最小 canonical prompt assembly，每次发送前强制 flush 和重读 anchor。

* [ ] 接通 Pi 语义的 `read`、`edit`、`write`，展示紧凑事件和可打开的真实 diff。

* [ ] 记录 `edit`、`write` 前后状态，为关键里程碑二的文件 Rewind 留下足够事实。

* [ ] 接通 3 秒内结束的非交互短命令，不创建 Terminal 标签。

* [ ] 对请求交互输入的命令终止并返回明确不支持错误。

* [ ] Agent 写回 Issue 后由 watcher 刷新编辑器。

* [ ] 将工具和 provider 错误完整传递给模型和 UI。

* [ ] 建立 Worker、adapter、ToolHost、store 和基础 UI 自动化测试。

* [ ] 回归普通 PTY 和外部 Agent CLI。

MVP 退出条件：

* [ ] 从真实 Issue 完成一次“读 Issue -> 读代码 -> 修改 -> 短测试 -> 写回 Issue -> 最终回答”。

* [ ] 实际请求使用 canonical project prompt 和发送前最新 Issue。

* [ ] 所有文件和终端副作用都经过 Iris main 并可追溯。

* [ ] UI 可达真实错误、diff 和命令结果。

* [ ] 产品明确显示当前版本尚不具备自举资格。

### 第三阶段：核心功能与关键里程碑二

目标是完成自举所需的全部可信性条件。任何子项缺失都不能进入第四阶段。

#### 完整 Prompt 与可观测性

* [ ] 实现固定顺序、版本化的完整 prompt assembly，保持 Agent 基础提示词、Iris software prompt 和 project prompt 为独立层。

* [ ] 记录 Pi 上游 prompt、Iris 最小适配、software prompt、project prompt、anchor、历史和工具 schema 的 revision/fingerprint。

* [ ] 实现 Context Inspector，展示实际发送的脱敏上下文、来源、顺序、token、compaction 和裁剪。

* [ ] 展示工具参数、结果、错误、diff、关联终端和 correlation ID。

* [ ] 展示 provider、模型、请求状态、retry、usage 和错误链。

* [ ] 从 Agent 历史和工具详情进入同一个完整真实终端。

* [ ] 验证凭据不进入 Inspector、Renderer、项目文件、终端输入日志和普通日志。

#### 多 Session 与 Fork

* [ ] 支持同一 Issue 下多个 Iris Agent Session 的新建、切换和状态展示。

* [ ] 支持 Session 重命名、结束运行、归档、删除历史和重启恢复。

* [ ] 实现从完成节点 Fork，只复制线性历史前缀、anchor 和必要配置。

* [ ] 禁止 Fork 复制终端、进程、未完成工具、受管修改所有权和外部状态。

* [ ] Fork Session 首次发送时重新读取真实工作区。

* [ ] 保持 Issue 状态与 Session 生命周期解耦。

#### Agent Terminal 与长命令

* [ ] 实现 Agent 内部工作面 registry，固定包含 Agent 并可加入 Terminal。

* [ ] 实现 3 秒显示规则、完整输出重放和用户切回后不再抢焦点。

* [ ] 复用真实 xterm、搜索、resize 和完整磁盘输出读取。

* [ ] 允许用户向运行中的 Agent PTY 输入，但不持久化明文键盘内容。

* [ ] 保证 terminal tool call 期间主 Agent loop 严格同步。

* [ ] 实现每 20 秒按游标读取增量输出的隔离监督调用。

* [ ] 监督异常时停止监督但不 suspend 或自动终止进程，UI 明示进程仍在运行。

* [ ] 命令结束后只向主 Agent loop 返回一次最终结果。

* [ ] 实现终端软配额、硬上限、告警和 `OutputLimitExceeded`。

#### 完整 Rewind

* [ ] 在完成节点菜单中提供“仅 Rewind 对话”和“Rewind 对话和文件”。

* [ ] 根据当前线性消息后缀收集该 Session 的 `edit`、`write` 修改。

* [ ] 展示消息范围、文件清单和不支持副作用说明。

* [ ] 写入前预检全部文件 revision，任何冲突都整体停止。

* [ ] 按反向顺序原子恢复每个文件，全部成功后才截断消息。

* [ ] 中途失败时展示真实状态、不移动消息，并允许重试剩余文件。

* [ ] 覆盖创建文件、连续修改、外部变化、部分失败和跨 Session 修改测试。

#### OpenAI-Compatible 多 Provider

* [ ] 枚举并读取 Pi SDK 已配置的 OpenAI-compatible provider 和模型。

* [ ] 使用统一 adapter 完成 provider/model 选择、切换、流式响应、tool call、usage 和错误展示。

* [ ] 覆盖 Pi SDK 支持和配置的全部 OpenAI-compatible provider。

* [ ] 为每个 provider 运行 adapter contract tests，并至少完成代表性真实 provider smoke。

#### 关键里程碑二：允许开始自举开发 Iris

以下项目必须在同一个真实 Iris Issue 上端到端完成，不能用互不相连的演示拼接：

* [ ] 从真实 Issue 创建 Agent，并确认固定 anchor 全程正确。

* [ ] 审计实际请求，确认使用正确的 Pi-derived Agent 基础提示词、Iris 最小适配、software prompt、canonical project prompt 和最新 Issue。

* [ ] Agent 读取 Iris 代码并通过受管工具完成一个范围可控的真实修改。

* [ ] 运行真实短测试和超过 3 秒的长命令，完整终端可见且监督不污染历史。

* [ ] 用户在长命令 Terminal 中完成一次交互输入，并确认明文输入没有被持久化。

* [ ] Agent 将方案、结果和待办写回原 Issue，并验证 watcher 和并发冲突。

* [ ] 从完成节点 Fork，新 Session 只继承历史前缀并读取当前工作区。

* [ ] 执行“仅 Rewind 对话”，确认工作区保持不变且旧后缀不可恢复。

* [ ] 执行“Rewind 对话和文件”，确认受管文件准确恢复且没有虚假回滚其他副作用。

* [ ] 验证全部 OpenAI-compatible provider 配置可以通过统一 adapter 工作或给出准确 capability/error。

* [ ] 从故意制造的 prompt、工具或 provider 错误追溯到上下文、错误链和终端证据。

* [ ] 通过 Worker 崩溃、renderer reload、应用重启、项目切换和普通 PTY/外部 CLI 回归。

* [ ] 由用户人工确认 Iris Agent 达到自举准入标准。

只有最后一项由用户确认后，才允许使用 Iris Agent 开发自身或第四阶段功能。

### 第四阶段：后续产品化

关键里程碑二之后再补齐非 OpenAI 协议、完整认证 UI、日常体验和发布能力。

#### Provider 与产品体验

* [ ] 支持 Anthropic Messages 等非 OpenAI-compatible 协议族。

* [ ] 实现 Iris 内置 provider 登录、登出、凭据健康状态、模型选择和 thinking level。

* [ ] 对 tool call、thinking、图片、上下文窗口和 usage 做显式 capability 降级。

* [ ] 扩展 Context Inspector 的请求对比、重试、压缩历史和诊断导出。

* [ ] 完善 Session 搜索、排序、归档、取消归档和 Fork lineage 详情。

* [ ] 单独评估候选回答 regenerate，不与 Fork 或 Rewind 混淆。

* [ ] 保留普通终端和外部 Agent CLI 作为一等入口与故障逃生路径。

#### 可靠性与发布

* [ ] 为 Session store、受管修改记录和协议建立 schema migration。

* [ ] 定义同一项目重复打开时收敛到已有窗口的产品与实现方案。

* [ ] 验证多 Issue、多 Agent、多普通终端并存时的资源负载。

* [ ] 为长对话、超大 diff、高输出终端和频繁 Fork 定义预算与降级。

* [ ] 覆盖窗口关闭、renderer reload、Worker 崩溃、断线、重启和安装版 runtime。

* [ ] 在 Windows、PowerShell/cmd/Bash 和至少两个协议族上完成真实验证。

* [ ] 为 Pi SDK 升级运行 contract tests 和 provider smoke。

* [ ] 审计许可证、第三方声明、安装体积和启动成本。

* [ ] 更新 README 和产品内边界说明。

* [ ] 完成“打开 Agent -> 修改 -> 短测试 -> 长命令 -> Fork -> Rewind -> 写回 -> Git 提交”发布验收。

* [ ] 由用户决定是否合并、默认启用和发布。

## 总体验收标准

* [ ] Issue 是多 Session 的组织点和长期记忆，不依赖任一聊天历史才能继续工作。

* [ ] 用户可以快速工作，也能直接检查模型实际上下文、完整终端、真实 diff 和错误链。

* [ ] 单 Session 的长任务保持同步因果关系，正常监督不污染历史。

* [ ] 用户通过显式新建和 Fork 管理并行路径，系统没有隐藏子 Agent 或后台任务图。

* [ ] Fork、消息 Rewind 与消息和文件 Rewind 的边界在数据、交互和文案中一致。

* [ ] 产品不提供消息 Rewind 后缀恢复，也不暗示 Rewind 可以恢复不受支持的外部世界。

* [ ] Pi 可以被替换或升级，Iris 产品语义没有泄漏进 Pi adapter 之外。

* [ ] Agent 专属基础提示词始终可追溯到锁定的 Pi 上游版本，Iris 只保留经审查的最小适配。

* [ ] 关键里程碑二覆盖全部 OpenAI-compatible provider；其他协议族明确属于后续阶段。

* [ ] 普通终端和外部 Agent CLI 保持可用，不因内置 Agent 退化。

* [ ] 自举只在全部核心门禁通过并经用户确认后开始。

## 第一阶段调查记录

### 2026-08-13：Pi 官方仓库与 npm scope 沿革

初次探测曾把 `@earendil-works/pi-coding-agent` 误判为第三方 fork，现已根据官网、仓库重定向、npm 发布时间线和维护者信息纠正：

* Pi 原仓库和 npm scope 是 `badlogic/pi-mono`、`@mariozechner/*`；`@mariozechner/pi-coding-agent` 的最后版本为 `0.73.1`，发布于 2026-05-07。

* 项目随后迁移到官方组织 `earendil-works/pi` 和 `@earendil-works/*` scope；新 scope 在同一天从 `0.74.0` 连续发布，当前官网 `pi.dev`、README、GitHub 和 npm 均指向 `@earendil-works/pi-coding-agent`。

* 新旧 npm 包维护者重合，旧 GitHub 地址会重定向到 `earendil-works/pi`。因此这是一条连续的官方项目版本线，不是两个竞争实现，也不应把旧 scope 的 `0.73.1` 当作当前 SDK。

* 本机 `pi` 为当前官方 `@earendil-works/pi-coding-agent@0.84.1`，其认证和模型配置位于 `~/.pi/agent`。第一阶段后续应围绕精确锁定的 `@earendil-works/*` 包验证，不再使用 `@mariozechner/*` 旧包。

* `0.84.1` 的公开包根导出包括主 SDK、`./client` 和 `./rpc-entry`，许可证为 MIT；正式实现仍只允许通过承诺的 package exports 进入，不能引用内部 `dist` 路径。

* `0.84.1` 声明 Node `>=22.19.0`，而 Iris 当前 Electron 31 内置 Node 20。系统 Node 24 可以运行本机 Pi CLI，但不能证明安装版 Electron Worker 可直接加载 SDK。第一阶段必须在升级 Electron与随包交付独立 Worker runtime 之间作出验证后的明确选择，之后才能勾选版本和 runtime 退出条件。

### 2026-08-13：升级 Electron 的影响评估

满足 Pi `0.84.1` 的最低 Electron 代际是 Electron 39，其内置 Node 为 `22.20.0`；Electron 38 仍是 Node `22.18.0`，不满足 Pi 的 `>=22.19.0`。但 Electron 39 已不适合作为 2026-08 的新长期基线，若选择升级，应直接验证当前受支持代际，而不是停在刚好满足版本条件的旧代际。当前 Electron 43 内置 Node `24.17.0`，与开发机 Node 24 同代并满足 Pi 要求。

对 Iris 的已知影响如下：

* 主进程和 preload 迁移量预计较小。Iris 使用的是 `BrowserWindow`、`ipcMain`、`contextBridge`、`ipcRenderer`、`webUtils`、`dialog`、`shell` 等稳定公开 API；已经使用 `webUtils.getPathForFile`、安全的 IPC wrapper、`render-process-gone` 和 `setWindowOpenHandler`，没有命中从 Electron 32 到 43 已知的主要移除 API。

* 最大技术风险是 `node-pty`。Electron 升级会改变 Node/V8/native ABI；虽然当前 `node-pty@1.1.0` 带 Windows x64/arm64 prebuild，且现有配置依赖预编译产物并关闭 `npmRebuild`，仍必须用目标 Electron 实际启动 ConPTY，验证创建、输入、resize、退出、进程树终止和安装包加载。不能仅靠 TypeScript 或单元测试认定兼容。

* Chromium 会从 126 跨到 150，renderer 的实际回归面大于 Electron API 迁移面。需要重点回归 CodeMirror/Milkdown 编辑、IME、拖放文件、剪贴板、xterm/WebGL、窗口缩放、焦点、后台节流、链接导航和多窗口关闭 flush。现有 `webUtils.getPathForFile` 已兼容 Electron 32 移除 DOM `File.path` 的变化。

* 构建链需要联动验证。当前 `electron-vite@2.3.0`、Vite 5、`electron-builder@26.15.2` 不一定都需要立即升级，但必须验证它们能以目标 Electron 完成 main/preload/renderer build、native 依赖 externalize、asar unpack、portable 和 NSIS 安装版运行。禁止把 Electron、electron-vite、Vite 和业务改造混在一个不可定位的超大升级中。

* 安装包体积、冷启动、内存和 GPU 行为可能变化。Electron 自身升级通常不会增加第二套完整 runtime，但新的 Chromium/V8 和加入 Pi SDK 后仍需重新测量；Pi 的 provider SDK、图片处理 native 包和模型数据也会扩大依赖面。

* 运行时语义会统一。升级后 main、Worker 和 Pi SDK 可以共享安装包内同一 Node runtime，生命周期、崩溃隔离、路径、签名、更新和诊断都比额外捆绑一个 `node.exe` 简单。独立 runtime 虽能避免 Electron 升级，却会新增一套可执行文件交付、签名、进程回收、IPC、版本更新和安全维护责任，并增加安装体积。

建议路线是优先升级 Electron，但先做独立兼容 spike，不立即连带升级全部前端工具：

1. 在专门提交中把 Electron 精确锁到选定的当前受支持版本，保持业务逻辑不变。
2. 运行 typecheck、单元测试和现有 smoke，修复确定的 API 或类型变化。
3. 手工回归编辑器、IME、拖放、剪贴板、普通 PTY、外部 Agent CLI、多窗口、关闭 flush 和 renderer crash 恢复。
4. 验证 `node-pty` 在开发态和实际 Windows portable/NSIS 产物中工作；打包验证属于发布门禁，但不得用 `npm run dist` 代替分项验证。
5. Electron 基线稳定后再引入精确锁定的 Pi SDK，单独验证 Worker 和 provider，避免两类变量混在一起。

若第 4 步证明 `node-pty` 或安装交付存在无法接受的阻塞，再回退评审随包交付独立 Node runtime；目前没有证据支持先选择复杂度更高的双 runtime 方案。

### 2026-08-13：Electron 43 自动化基线验证

用户手动升级并重启后，文件锁阻塞已解除。本地依赖与实际 Electron runtime 均已确认是
`43.4.0`，内置 Node `24.17.0` 满足 Pi SDK `0.84.1` 的 Node `>=22.19.0` 要求。

第三方声明、typecheck、全部单元测试、生产 build、产品元数据和现有 Electron 启动 smoke
均已通过。升级引入的 `@electron-internal/extract-zip@1.0.5` npm tarball 缺失 BSD-2-Clause
许可证文本，声明生成器已用严格包名和许可证标识重建标准文本，未放宽其他包的失败策略。

这组证据确定 Electron 43 可以作为 Iris Agent 第一阶段 Worker 的共同开发 runtime，后续
不再以独立 Node runtime 作为默认路线。现有 smoke 不创建真实 PTY，开发态 ConPTY、编辑器、
外部 Agent CLI 和安装产物仍需按独立风险 Issue 人工检查；在这些检查完成前，不把 Electron
升级本身标记为发布完成。

### 2026-08-13：Pi SDK 0.84.1 运行时与真实 Provider spike

依赖已将 `@earendil-works/pi-coding-agent` 精确锁定为 `0.84.1`。Iris ToolHost 定义 custom
tool 需要使用 Pi 公共契约中的 TypeBox schema，因此同时把 Pi 当前使用的 `typebox@1.3.7`
精确声明为直接运行依赖，避免依赖嵌套 hoist。正式代码只允许从
`@earendil-works/pi-coding-agent` 包根进入；已验证包根公开导出包含
`createAgentSession`、`DefaultResourceLoader`、`readStoredCredential`、
`createReadToolDefinition`、`createEditToolDefinition`、`createWriteToolDefinition` 和
`createBashToolDefinition`，不需要引用未承诺的 `dist/*` 子路径。

系统 Node 24、Electron 43 的 Node 模式以及 Electron 43 的 Node Worker 均能加载同一个公开
包根。Pi 的认证存储非秘密枚举显示 `deepseek` 已配置为 stored API key，模型使用
`openai-completions`。spike 只输出 provider ID、认证类型和状态，没有读取或打印 credential
值。

真实 provider 结果：

* 自然结束：完整事件链包含 `agent_start`、`turn_start`、user/assistant
  `message_start`/`message_end`、51 个 `message_update`、`turn_end`、`agent_end` 和
  `agent_settled`；最终 `stopReason` 为 `stop`，usage 为 196 tokens。

* 取消：收到首个 assistant stream 事件后调用 `abort()`，最终 `stopReason` 为 `aborted`、
  输出和 usage 均为零，Session 回到 idle。

* tool call：只注册内存 `iris_probe` tool，模型恰好调用一次，tool start/end 各一次，结果
  返回后进入第二 turn 并自然结束；没有文件或进程副作用。

* provider 错误：使用脚本内临时无效 credential store，不修改 Pi 的 `auth.json`。错误通过
  assistant `message_end` 的 `stopReason: error` 结算，Session 回到 idle，调用 Promise 不一定
  reject。因此 Iris adapter 必须同时消费结构化事件错误和 thrown error，不能只依赖 catch。

资源边界 spike 显式启用 `noExtensions`、`noSkills`、`noPromptTemplates`、`noThemes` 和
`noContextFiles`，并使用 `noTools: "all"` 与 in-memory SessionManager。结果 extensions、skills、
prompts、themes、AGENTS context 和 tools 均为空，没有加载 Pi TUI 配置、项目 `.pi`、subagent、
permission 或 sandbox。公开 system prompt builder 在 custom prompt 后仍固定追加规范化 cwd；
这属于可观察的上游固定层，Iris 需要纳入 fingerprint 和 Inspector，不能宣称逐字完全覆盖。

固定 cwd `C:/iris-prompt-root`、默认 `read`/`bash`/`edit`/`write` 下，Pi 0.84.1 默认 prompt
规范化后为 2585 bytes、31 行，SHA-256 为
`bfd83ad660a7f76ee86a8beee63c80eda1441be7f717ae156dedaf0029c85293`。最小适配应保留
Pi 的精确编辑指导，把产品名改为 Iris Agent、`bash` 映射为可见 `terminal`，删除 custom
tools、`PI_*` 环境变量和 Pi docs/extensions/TUI/skills 段，并把运行目录文案改成 Iris
ToolHost 的真实项目边界。正式内置资源仍需记录适配 patch 版本和最终 fingerprint。

Pi 四个 tool definition 已用纯内存 operations 实际执行：相对路径按 cwd 解析，`edit` 产生
标准 patch，`write` 先调用 mkdir 再写入，terminal 通过 `exec`、`onData` 和 `AbortSignal`
流式返回；非零退出将完整输出与退出码包装为 rejected Error。由此可确认 Iris main 能接管
文件和 PTY operations，Worker 不必直接写文件或启动进程。

许可证检查已覆盖 Pi monorepo、clipboard 平台包和 Pi provider 依赖中上游 tarball 漏发
LICENSE 的已知包，规则按精确包名和声明许可证匹配；未知漏文件包仍会让生成器失败。
`npm audit --omit=dev` 报告的旧 `undici@6.26.0` 和 `brace-expansion` 均来自既有
electron-builder 工具链；Pi 自身使用的 `undici@8.9.0` 和 `brace-expansion@5.0.9` 不在当前
advisory 影响范围。本阶段不使用全局 override 干预构建链，后续 Electron 发布风险检查单独
跟踪升级或定向修复。

### 2026-08-13：第一阶段可重复契约与退出结论

第一阶段的剩余 spike 已固化为源码和自动化契约，但没有接入 Renderer 或宣称达到 MVP。
`src/main/agent/pi-adapter.ts` 是生产源码中进入 Pi 的唯一窄入口，只从包根导入；资源加载器
关闭 extension、skill、prompt template、theme 和 context file 发现，Session 使用 Iris 提供的
四个 ToolHost operation。Pi 的 `bash` 定义在 adapter 中改名为 `terminal`，关闭 `PI_*`
Session 环境暴露，文件和命令副作用仍由 main 注入的 operation 执行。

Pi-derived Agent 基础提示词已内置为适配版本 1。上游固定 cwd
`C:/iris-prompt-root` 的默认 prompt fingerprint 为
`bfd83ad660a7f76ee86a8beee63c80eda1441be7f717ae156dedaf0029c85293`；Iris 适配基础文本
fingerprint 为 `984689f4d2404091aa7f17a59cf10e1b61ce278241ad0d4fef37fd39dd1d433d`，计入 Pi 固定追加
cwd 层后的最终 fingerprint 为
`6b6cd774a3e79df8c0d9dc4d21e9bd281ebf0e3cb4fef49556cbb8fe9e4b3727`。适配只改产品名、
工具名和宿主运行边界，并删除 custom tool、`PI_*`、Pi docs、extension、TUI 和 skill 指导；
Pi 的精确 edit 行为指导保留。canonical assembler 强制先 flush，再读取 software、project 和
固定 document/workspace anchor 的最新快照，按 Agent base、software、project、anchor 顺序
组装，并为整体和每层分别生成 fingerprint。

`src/shared/agent-protocol.ts` 定义 v1 Worker envelope 和贯穿 Session、request、turn、tool call、
terminal 的 correlation 字段。Worker 作为 electron-vite 独立入口输出到
`out/main/agent-worker.js`；host 懒启动，每次启动先读取 Iris 持久历史，空闲退出或崩溃后下次
启动重新读取，Worker error 使用 Session 局部事件而不是主进程 `EventEmitter` 的 fatal
`error` 语义。`npm run agent:worker-check` 使用 Electron 43 自身的 Node 模式启动真实构建
Worker，返回 Node `24.18.1`、Pi `0.84.1` 和协议 v1。Worker 与 main 共用安装包 Electron
runtime，构建产物沿用 electron-builder 已有的 `out/**` 应用交付路径；安装版实际启动检查仍由
Electron 43 风险 Issue 跟踪。

Iris 自有线性历史契约只给所有工具均已结算的 turn 建稳定完成节点。消息 Rewind 要求 Session
idle，并直接产生目标节点以前的新线性历史，不暴露旧后缀恢复；Fork 深复制同一完成节点以前的
线性前缀，后续 Worker 从 Iris 当前历史和真实工作区重建。Pi 自身的 append-only branch tree
仅证明 SDK 能重建上下文，不承担 Iris 产品持久化或分支语义。

独立命令 PTY 使用一次性非交互 shell，不在命令后返回交互 prompt。状态机在 3 秒阈值仍运行时
只发一次显示事件；原始 PTY bytes 顺序 append 到 Iris 指定路径，增量事件携带单调 byte cursor，
最终结果等待全部 append 结算后只产生一次。磁盘写入失败会 reject，不会把不完整输出谎报为
完整结果。自动化同时覆盖假时钟的精确 3 秒边界和真实 Windows ConPTY 的分段输出、完整落盘、
退出码与单次结算。临时监督调用的接口固定为无工具、固定规则和游标增量输入，只有诊断事实
输出，没有正式历史或 ToolHost 写入口。

最终门禁结果：`npm run licenses:check`、`npm run typecheck`、完整 `70` 个测试文件 `377` 项
测试、`npm run build`、`npm run metadata:check`、`npm run agent:worker-check` 和
`npm run smoke` 全部通过。生产构建明确生成独立 Agent Worker，应用 smoke 在 5 秒内完成
主进程和窗口启动。按项目约束未运行 `npm run dist`，也没有用开发服务器截图替代人工测试。
第一阶段技术退出条件已满足；第二阶段的正式 store、IPC、UI、真实产品入口和消息 Rewind 交互
仍保持未完成。
