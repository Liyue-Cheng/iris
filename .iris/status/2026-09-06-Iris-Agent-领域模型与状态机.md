---
title: Iris Agent 领域模型与状态机
---

# Iris Agent 领域模型与状态机

这份文档描述 Iris Agent 当前已经采用的领域模型。它关注对象的职责、状态的语义和跨层不变量，
不把某个 TypeScript 类型、IPC 方法或界面卡片当成模型本身。

## 一、领域边界

Iris Agent 以 Session 为聚合边界，以 Intent 为用户价值单位，以 Turn 为执行事实单位：

```text
Session
  ├─ Provider（Session 当前可调整的执行配置）
  ├─ Intent（用户想完成的一项事情）
  │    └─ Turn（一次完整的执行轮次）
  │         ├─ Invoke（一次与 provider 无关的逻辑调用）
  │         │    └─ Attempt（一次具体执行尝试）
  │         └─ ToolCall / Tool Operation（模型请求及其实际结算）
  ├─ Trace（当前 Session 中有效的 Agent 流程事实）
  └─ Context（从 Trace 推导出的 provider 输入）
```

各层职责如下：

* **Session** 管理一组 Intent 的共同边界、持久化版本、当前执行权和运行时资源。
  Provider 属于 Session，是当前可调整的执行配置；用户可以在暂停期间切换 provider，之后继续同一个 Intent。
* **Intent** 表达用户的一项意图及其生命周期，是状态机的第一公民。
* **Turn** 表达 Intent 的一次完整推进。Stop 后 Continue 会在同一 Intent 下追加 Turn，而不是覆盖旧 Turn。
* **Invoke** 表达一次与 provider 无关的逻辑调用，即“为当前 Turn 获取一次模型决策结果”。
  Invoke 不拥有 provider，也不存在 provider 维度的本体失败。
* **Attempt** 表达 Invoke 的一次具体执行尝试。Attempt 在开始时查询 Session 当前 Provider，按该配置执行，
  并记录这次尝试的生命周期结果；Provider 的实际请求身份由执行上下文记录，Attempt 不持有 Provider 配置的所有权，
  也不决定后续使用哪个 Provider。
* **ToolCall** 是模型提出的工具请求；**Tool Operation** 是主进程实际执行并结算的世界操作。
* **Trace** 记录当前有效的 Agent 流程事实；**Context** 是 Trace 的 provider-neutral 投影，不是另一份事实库。

文件、目录、终端以及外部命令产生的现实副作用不属于 Trace。当前模型不维护独立 Effect Ledger，
也不承诺通过 Agent 历史操作恢复现实世界。

这不是“工具不能改世界”：Tool Operation 仍然可以读写文件、创建目录或启动终端，
并把本次操作的成功、失败和返回内容交给模型。被排除的是副作用的持久化记录、artifact
索引、审计 receipt、分支复制和 Rewind 恢复。Agent 只保存理想流程事实；外部现实状态由
后续工具调用重新读取和确认。

## 二、Intent 四态

Intent 只有四个正式状态。状态名不能按自然语言泛化解释，尤其不能把 `superseded` 当成失败、
删除或任意形式的“过期”。

| 状态 | 领域含义 | 执行资格 | 后续操作 |
| --- | --- | --- | --- |
| `running` | 当前 Intent 正在推进，可能正在等待 provider 或工具 | 拥有当前执行权 | 等待收束或 Stop |
| `paused` | 推进暂时停止，但原目标仍然成立 | 保留继续资格 | Continue/Retry，或由新输入接管 |
| `superseded` | 一个暂停中的 Intent 被明确的后继 Intent 接管 | 在当前 Trace 中不能直接继续 | Rewind 后继，或从该输入 Fork |
| `completed` | Intent 已经正常完成并收束 | 不再拥有执行权 | 查看，或从其边界 Fork |

`paused` 与 `superseded` 的区别是执行资格：暂停仍表示“这件事可以原地继续”，接管则表示“当前方向
已经交给后继 Intent”。`completed` 与 `superseded` 的区别是目标结果：前者已完成原目标，后者的
原目标并未完成，只是被新的方向取代。

`superseded` 是关系性状态。在当前 Trace 中，它必须能由紧邻的后继 Intent 解释；没有接管者的
`superseded` 不能成为 Trace head。

## 三、Intent 状态转换

普通 Agent 执行只做前向转换：

```text
running ──Stop / 运行条件消失──> paused
paused  ──Continue / Retry─────> running
paused  ──新输入接管──────────> superseded + 新 Intent(running)
running ──最终回复正常收束────> completed
```

转换规则：

* `running -> paused` 表示推进被暂时阻断，不表示 Intent 失败。
* `paused -> running` 继续同一个 Intent，保留 Intent identity，并在其下追加新的 Turn。
* `paused -> superseded` 与后继 Intent 的创建必须属于同一次 Session 提交；新输入使用新的 Intent identity。
* `running -> completed` 只在最终 assistant 结果提交、相关执行事实完成结算后发生。
* `completed` 不能在原 Trace 中重新进入 `running`。
* `superseded` 不能直接 Retry；只有 Rewind 撤回其接管者后，才恢复为 `paused`，再由 Continue 进入 `running`。

普通 Send 不会删除被接管 Intent 的输入、回复或工具事实。`superseded` 改变的是执行资格，不是历史可见性。

## 四、Session 运行时状态

Session runtime state 描述执行设施当前处于什么阶段，不表达 Intent 的业务结果：

| Session 状态 | 含义 |
| --- | --- |
| `starting` | 已接受执行请求，Worker 尚未完成启动屏障 |
| `ready` | Worker 可用，当前没有执行中的 Intent |
| `running` | provider 正在生成，或执行循环正在推进 |
| `waiting-tool` | 当前 Turn 正在等待工具结算 |
| `retry-wait` | provider 内部自动重试等待 |
| `stopping` | Stop 已受理，正在关闭执行资源 |
| `interrupted` | Worker 报告中断的瞬时状态，随后归并为 paused |
| `paused` | 当前 Intent 已暂停且可以继续 |
| `idle` | 当前没有正在执行的 Intent |

Session 的 `paused` 是运行时投影，Intent 的 `paused` 才是持久化的业务语义。`idle` 只表示当前不忙，
不表示 Session 没有 Trace 或历史 Intent。

## 五、Provider、Invoke、Attempt 与错误归属

Provider 是 Session 级的可变配置，不是 Invoke 或 Attempt 的身份。Invoke 是 provider-neutral 的逻辑请求；
Attempt 只在执行边界查询并记录当时实际使用的 Provider。暂停是切换 Provider 的屏障：运行中的 Attempt
先结束或中止，恢复时在同一 Invoke 下创建新的 Attempt，新 Attempt 查询最新 Session 配置。

执行层允许具体尝试失败，但 Intent 没有 `failed` 状态。每一层先消化自己能够理解和处理的问题，只把“当前
无法继续推进”的控制结论上浮到 Intent。

| 实体 | 状态 | 责任边界 |
| --- | --- | --- |
| Turn | `running` / `settled` | 一次执行轮次是否已经收束 |
| Invoke | `running` / `holding` / `completed` / `aborted` | 一次 provider-neutral 逻辑调用；暂时无法执行时 holding，绝不以 provider 失败收束 |
| Attempt | `running` / `completed` / `failed` / `aborted` | 一次查询 Session Provider 后进行的具体尝试 |
| Tool Operation | `running` / `completed` / `failed` | 一次确定性世界操作的结算 |
| Reply Activity | `streaming` / `completed` / `stopped` / `failed` | UI 回复及其 Context 纳入状态 |
| Tool Activity | `running` / `completed` / `failed` / `canceled` | UI 工具活动的流程投影 |

具体规则：

* 临时网络错误、限流或超时属于 Attempt 事实；可在 Attempt 内重试。
* 多次 Attempt 仍未获得结果时，Invoke 进入 `holding`，向上发出“暂时无法继续”的受控信号，Intent 进入 `paused`。
  这不是 Invoke 失败，而是等待网络恢复、provider 可用、配置调整或用户稍后继续。
* 用户可以在 paused/holding 期间切换 Session Provider。Continue 时保留同一 Intent 和 Invoke，创建新的 Attempt，
  新 Attempt 查询新的 Provider 配置。
* 用户在 holding/paused 期间提交新输入时，旧 Intent 进入 `superseded`；其未完成 Invoke 结算为 `aborted`。
  `aborted` 表示当前路径放弃该逻辑调用，不表示 provider 执行失败。
* `ENOENT`、权限拒绝或参数错误等 Tool Operation 失败，是模型可以理解的工具结果。Worker 将其转换为
  `toolResult(isError=true)` 继续执行，而不是把一次工具失败升级为整个 Intent 暂停。
* 用户 Stop 是控制命令，不是 provider 错误。它终止当前运行资源，并将 Intent 收束为 `paused`。
* Worker 崩溃或应用重启时，未收束 Intent 恢复为 `paused`；已经提交的 Trace 事实仍可用于重建 Context。

Invoke 的生命周期可以概括为：

```text
running ──得到结果────────────> completed
   │
   ├─本次 Attempt 失败，继续尝试 ──> running
   ├─多次尝试仍无结果────────────> holding ──继续──> running
   └─当前路径被用户新输入接管────> aborted
```

`holding` 是等待外部条件恢复的开放状态，不是错误终态。只要 Intent 没有被 supersede，用户就可以修复
网络、切换 Session Provider 或调整配置，然后在同一 Invoke 下创建新的 Attempt。Provider 的变化发生在
Session 配置层，不是 Invoke 的状态变化。

## 六、Trace、Context 与投影

Trace 的本质是 Agent 的**理想流**：在领域语义中，Agent 如何理解用户输入、如何推进 Intent、产生什么
assistant 回复、提出什么 ToolCall、得到什么 tool result。这里的“用户输入”指构成 Intent 的业务输入；
Stop、切换 Provider、Retry、Fork、Rewind 等人工控制不属于理想流。Trace 只承载这些可由 Agent 流程本身
解释的事实。

外部世界的偶然噪声和人工操作不属于理想流，因此不进入 Trace，包括网络抖动、provider 不可用、Attempt
重试细节、provider raw frame、用户 Stop、切换 Provider、Fork、Rewind 以及现实副作用本身。它们可以作为
运行时控制、配置变化或人工操作被系统处理，但不能污染 Agent 流程事实。

Trace 包含用户输入、Intent、Turn、assistant 回复、ToolCall 和 tool result 等理想流事实。只有理想流才能
稳定地通过纯函数映射出 Context；如果把偶然失败、人工干预或实现细节写进 Trace，Context 就会被迫解释
这些与任务无关的历史噪声，投影也不再保持单纯的 provider-neutral 语义。

```text
Trace + Context policy + 当前锚点材料 ──纯投影──> Context
```

必须保持以下边界：

* `currentIntentId` 只决定当前执行权，不决定旧事实是否可见。
* `superseded` Intent 仍属于当前 Trace，并继续出现在历史投影中。
* Context 是否携带某段历史由 Context policy 决定，不能通过删除 Intent 来隐式表达。
* Compaction 只改变 Context 的呈现方式，不改写 Trace。
* Provider 选择、Attempt 失败和暂停/恢复等非理想信息不进入 Trace；它们只影响下一次是否能够继续生成理想流。
* Renderer 只消费 Session projection，不拥有领域状态，也不自行解释 provider raw frame。

当前实现以 `activeIntentIds` 表示有效 Trace 的 Intent 顺序。存储结构中可能存在已脱离有效 Trace 的兼容数据，
但它们不属于当前领域视角，也不构成 Fork/Rewind 审计记录。

## 七、Rewind：截断当前 Trace

Rewind 属于人工操作面，不是 Agent 流程事件，不写入 Trace。它的语义是直接将当前 Session 的 Trace
截断到选定前缀：

1. 移除选定位置之后的 Trace 尾部。
2. 不把被截断 Intent 改写为 `superseded`；离开 Trace 不等于被新输入接管。
3. 如果截断后的 head 是因被移除后继而处于 `superseded` 的 Intent，则将其恢复为 `paused`，并设为当前 Intent。
4. 如果新的 head 是 `completed`，或 Trace 已为空，则 Session 没有当前 Intent，并进入 idle。

示例：

```text
A(paused) ──新输入接管──> A(superseded) -> B(completed)

Rewind B

A(paused)，currentIntentId = A
```

多级接管按 Trace 尾部逐层撤回：`A(superseded) -> B(superseded) -> C` 中，第一次 Rewind C 只恢复 B，
再次 Rewind B 才恢复 A。

Rewind 只回退 Agent 的认知流程，不恢复文件、目录、终端或外部命令造成的现实变化。操作完成后的 Agent
必须把外部世界视为需要重新读取和确认的当前事实。

## 八、Fork：从 Trace 前缀创建新 Session

Fork 同样属于人工操作面，不写入来源 Trace。它创建新的 Session 和 Trace，来源 Session 完全不变。

### Reply Fork

* 分支点必须是 `completed` Intent 的结果边界。
* 新 Session 继承截至该结果的 Trace 前缀。
* 新 Session 没有当前 Intent，初始运行态为 idle。
* 来源 Intent 继续保持 `completed`。

### Input Fork

* 目标输入可以属于 `paused`、`completed` 或 `superseded` Intent；`running` Intent 必须先停止。
* 新 Session 复制目标输入之前的 Trace 前缀。
* 目标输入在新 Session 中重新物化为 `paused` Intent，成为 `currentIntentId`，等待用户继续执行。
* 目标原有的 Turn、Invoke、Tool 和回复执行事实不复制到新分支。
* 来源 Session 的状态、接管关系和 Trace 不发生任何变化。

从来源分支的 `superseded` 输入 Fork 时，新分支没有原接管后继，因此该输入在新 Session 中表现为
`paused`。这是新聚合的状态，不是对来源 Session 的回退。

Intent identity 的聚合边界是 Session；跨 Session 判断身份时必须同时考虑 `sessionId` 和 `intentId`。

## 九、持久化与并发不变量

Session journal 是流程事实的提交边界。Session mutation 必须串行处理，并通过 revision、Worker epoch、
Intent identity 和 Operation identity 拒绝迟到或重复事件。

跨层不变量如下：

* 存在 `currentIntentId` 时，它必须指向当前 Trace 中的 `running` 或 `paused` Intent。
* Trace head 不能是无法由后继解释的 `superseded` Intent。
* 暂停 Intent 的 Continue 保留 Intent identity；暂停期间的新输入必须创建新的 Intent。
* 普通执行不会将 `superseded` Intent 从历史投影中删除。
* Rewind 不制造 `superseded`，Fork 不修改来源 Session。
* Tool Operation 的失败必须能作为 `isError` tool result 被 provider 消费，不能仅凭 `ok:false` 暂停 Intent。
* Trace 不依赖 provider runtime 存活；Worker 重启后可以从持久化事实重建 Context。

## 十、当前实现状态

领域方案已经收敛为上述最小模型，现有实现已按该语义统一 Intent/Turn/Invoke/Attempt 分层、暂停接管、
工具错误回传、Trace 截断和 Fork 等主链路。

* Intent、Turn、Invoke、Attempt 分层及 provider-neutral Context。
* Provider 归属于 Session；Invoke/Attempt 不拥有 Provider。Attempt 在执行时查询并记录当时的 Provider 配置。
* 暂停后发送新输入时，旧 Intent 保留在 Trace 中并进入 `superseded`，新 Intent 接管执行。
* 工具的 `ok:false` 被转换为 provider 可读的错误结果，不再直接升级为 `execution-paused`。
* Rewind 只截断有效 Trace，不记录 receipt，不恢复现实副作用；必要时将新的 head 恢复为 `paused`。
* Reply Fork 与 Input Fork 均创建新 Session；Input Fork 支持 `paused`、`completed` 和 `superseded` 输入。
* Agent aggregate 不包含 Effect 或 Rewind receipt。新执行不记录任何外部副作用；旧快照和旧 journal 中的 effect/receipt 字段在加载迁移时直接丢弃。
* Invoke 的目标语义是 `running` / `holding` / `completed` / `aborted`。历史数据中的 `failed` Invoke
  在迁移时归并为 `holding`；当前运行不会再产生 Invoke 级 `failed`。

验证结果：Agent 目录 12 个测试文件、119 项测试全部通过；TypeScript 类型检查和异步边界检查通过。
