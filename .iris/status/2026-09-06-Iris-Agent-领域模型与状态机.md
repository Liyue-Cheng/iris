---
title: Iris Agent 领域模型与状态机
---

# Iris Agent 领域模型与状态机

这份状态文档描述当前 Iris Agent 的领域模型，不把某个 TypeScript 类型或某个 IPC
函数当成模型本身。代码只是模型的一个运行时实现；模型首先回答四个问题：谁拥有
意图、一次执行产生什么事实、失败应该归属哪一层、哪些事实可以进入下一次 Context。

## 一、总体边界

Iris Agent 是一个以 Session 为容器、以 Intent 为用户价值单位、以 Turn 为执行事实
单位的系统：

```text
Session
  ├─ Intent（用户想完成什么）
  │    └─ Turn（一次 invoke + tool-call 循环）
  │         ├─ Invoke（一次 provider 调用）
  │         │    └─ Attempt（一次具体尝试）
  │         └─ ToolCall / Tool Operation（一次世界操作）
  ├─ Trace（已发生的领域事实）
  ├─ Context（由 Trace 推导的本次输入）
  └─ Effect（对文件、目录、终端等外部世界的副作用）
```

这些层级不是同义词，也不是简单的 UI 分组：

* Session 决定一组意图的共同边界、当前模型偏好、锚点、持久化版本和当前执行权。
* Intent 表达用户的一项意图及其生命周期。它是第一公民，不因一次 provider 调用失败而失败。
* Turn 表达一次完整的“调用、解析、工具循环”。Turn 只关心执行是否已收束。
* Invoke 表达一次 provider 调用；Attempt 表达该调用的具体网络或传输尝试。
* ToolCall 是模型提出的工具请求；Tool Operation 是主进程实际执行并结算的世界操作。
* Trace 是事实源；Context 是面向下一次 provider 调用的纯投影，不是第二份事实库。
* Effect 是已经发生的外部副作用。可安全逆转的 Effect 带 CAS 所需的前后指纹；终端等不可逆副作用只记录，不假装能够撤销。

## 二、Intent 的四个正式状态

Intent 的状态不能按自然语言随意解释，尤其不能把 `superseded` 当成删除或失败。

| 状态 | 精确定义 | 执行权 | 可执行操作 | 历史地位 |
| --- | --- | --- | --- | --- |
| `running` | 当前意图正在推进，可能正在等待 provider 或工具 | 拥有 | 等待事件、Stop | 当前事实与当前目标 |
| `paused` | 推进条件暂时不存在，或用户主动停止；意图目标仍保留 | 暂不拥有运行中的 Worker，但保留继续资格 | Retry/Continue、或提交新输入覆盖 | 完整事实，保留原地继续语义 |
| `superseded` | 在当前有效路径上，暂停 Intent 被一个明确的后继 Intent 接管 | 当前路径上不能直接 Retry | 撤回后继，或从该输入 Fork | 正式历史事实，必须记录接管关系 |
| `completed` | 该意图已经正常完成并收束 | 不再拥有 | 查看、从完成点创建分支 | 正常完成历史 |

`superseded` 与 `completed` 都是收束态，但含义不同：

* `completed` 是“原目标已经完成”。
* `superseded` 是“原目标没有继续推进，后续方向被新目标接管”。

因此，`superseded` 不是只属于 Intent 自身的孤立标签，而是一个关系性状态：必须能
回答“在什么路径上、被哪个后继 Intent 接管”。Session 的 `currentIntentId` 指向当前
执行主导权；历史 Intent graph 保留全部事实，active path 表达当前采用的分支。Rewind
和 Fork 改变路径或聚合视角，因此可以让同一个历史输入在新的有效视角中重新表现为
`paused`，但不能篡改来源分支的事实。

## 三、Intent 状态转换

正常可达转换如下：

```text
                         ┌──────────────┐
                         │              │
                         ▼              │
running ──暂停/停止──> paused ──Retry──> running
   │                      │
   │                      └─新输入接管──> superseded
   │
   └─最终回复收束──> completed
```

补充约束：

* `running -> paused` 表示 provider、Worker、运行时或用户停止暂时阻断推进，不表示目标失败。
* `paused -> running` 只能由 Retry/Continue 触发，并且继续的是同一个 Intent。
* `paused -> superseded` 由新输入触发；新输入应创建新的 Intent，而不是复用旧 Intent ID。
* `running -> completed` 需要最终 assistant 结果已经提交，并完成 Turn/Invoke/Attempt 的结算。
* `completed` 不能在原路径回到 `running`。`superseded` 不能直接回到 `running`，但撤回其明确后继时应恢复为 `paused`，再由 Retry 进入 `running`。
* 普通 Send 不得把 superseded 从历史投影中删除；Rewind 移动 active path，Fork 创建另一个聚合视角。
* `superseded` 必须保存或可严格推导 `supersededByIntentId`；缺少接管者的 superseded 是不完整状态。

## 四、Session 运行时状态

Session runtime state 描述“当前运行时处于什么阶段”，不是 Intent 的业务结果：

| Session 状态 | 含义 | 典型来源 |
| --- | --- | --- |
| `starting` | 已接受新 Intent，Worker 尚未完成启动屏障 | Send 建立 Intent 后 |
| `ready` | Worker 可用，但当前没有执行中的 Intent | Worker 初始化完成 |
| `running` | provider 正在生成或执行循环 | run/resume、assistant 流式输出 |
| `waiting-tool` | 当前 Turn 暂停在工具操作边界 | tool-request 已发出 |
| `retry-wait` | provider 内部自动重试等待 | Attempt 层重试 |
| `stopping` | 用户 Stop 已获受理，正在关闭执行资源 | Stop 命令 |
| `idle` | 没有正在执行的 Intent | completed、superseded 或初始化后 |
| `paused` | 当前 Intent 暂停且可继续 | pause 信号已持久化 |
| `interrupted` | Worker 报告用户中断的瞬时运行态 | abort 事件，随后归并到 paused |

Session 状态可以短暂经过 `stopping` 或 `interrupted`，但持久化后的业务结论由
Intent 状态表达。`idle` 不等于“没有历史”，只表示当前没有忙碌执行。

## 五、执行层状态与失败归属

执行层可以失败，Intent 不以 failed 作为状态：

| 实体 | 状态 | 失败的含义 | 是否使 Intent 暂停 |
| --- | --- | --- | --- |
| Turn | `running` / `settled` | Turn 是否已收束；失败细节不放在 Turn 状态 | 由上层控制信号决定 |
| Invoke | `running` / `completed` / `failed` / `aborted` | 一次 provider 调用没有成功拿到结果 | 反复失败时暂停 |
| Attempt | `running` / `completed` / `failed` / `aborted` | 一次具体传输尝试的结果 | 由 Invoke 层消化重试 |
| Tool Operation | `running` / `completed` / `failed` | 确定性世界操作的结果 | 不应直接暂停；作为 tool error result 返回模型 |
| Reply Activity | `streaming` / `completed` / `stopped` / `failed` | UI 可读回复及其 Context 纳入状态 | Stop 或 provider 错误时排除 |
| Tool Activity | `running` / `completed` / `failed` / `canceled` | UI 对工具请求和结算的投影 | Stop 时取消，不代表 Intent failed |

错误归层规则是递归的：每一层先消化自己可以通过重试解决的问题，只把更高层能
理解的控制信号上浮。

* Invoke/Attempt 的临时网络错误属于 provider 执行噪音；内部重试，反复失败才发出“暂停推进”的信号。
* Tool Operation 的 `ENOENT`、权限拒绝、参数错误是确定性操作结果。它们应进入 `tool-result` 的 `isError` 内容，让模型决定重试、换路径或结束，而不是直接把 Intent 改成 paused。
* 用户 Stop 是控制命令，不是 provider 错误；它关闭 Worker/终端并把当前 Intent 置为 paused。
* Worker 崩溃或应用重启会恢复未收束 Intent 为 paused，并保留已提交的事实和可恢复的 Effect。

## 六、Turn、Invoke 与 ToolCall 的关系

一个 Intent 可以有多个 Turn。第一次执行创建第一个 Turn；Stop 后 Continue 会在同一
Intent 下追加新的 Turn，而不是覆盖旧 Turn。每个 Turn 对应一个 Invoke；同一个 Invoke
可有多个 Attempt。模型产生 ToolCall 后：

1. Worker 发出带 Intent、Turn、Invoke、ToolCall 和 Operation identity 的请求。
2. Main 将其持久化为 Tool Activity 和 Tool Operation，并执行文件、目录或终端操作。
3. Main 结算 Operation，发送成功结果或 `ok:false`。
4. Worker 将失败也转换为 provider 可读的 `toolResult(isError=true)`，继续当前 provider 循环。
5. 最终 assistant 回复提交后，Turn、Invoke、Attempt 和 Intent 按各自边界收束。

因此“工具失败”和“执行暂停”不是同一个事件：前者是 ToolCall 的结果，后者是
Invoke/Worker 层无法继续时给 Intent 的生命周期信号。

## 七、Trace、Context 与可见历史

Trace 是 Session 已发生事实的领域记录，Context 是一次调用所需的 provider-neutral
消息列表。两者关系是：

```text
Trace + Context policy + 当前锚点材料  ──纯函数──>  Context
```

当前约定：

* Intent、Turn、已结算的 assistant/tool 事实进入 Trace；Attempt 重试细节和 provider raw frame 不进入 Trace。
* superseded Intent 仍是 Trace 事实。它失去执行权，但不能从 UI 历史或审计记录消失。
* `currentIntentId` 决定谁能继续执行；它不决定旧事实是否存在。
* Context 是否携带 superseded 历史由明确策略决定，不能用“从数组删除实体”来隐式表达。
* Rewind 是显式的有效前缀截断；它可以让被截断 Intent 不再进入后续 Context，但原始 journal/effect receipt 仍可审计。
* 中断 tool result 可以在 Context 投影时合成，不把合成内容写回 Trace。
* Compaction 只改变 Context 呈现，不改写 Trace；摘要边界失效时回退到仍然有效的历史策略。

## 八、Effect、Rewind 与 Fork

Effect 是事实 ledger，不是 UI 卡片。文件写入保存 before/after 指纹及 artifact，
Rewind 只有在当前内容仍与 after 指纹匹配时才执行恢复；CAS 不匹配就拒绝，避免覆盖
用户或其他工具的新修改。新建文件可以精确删除，目录只能尽力清理。终端输出和外部
命令属于不可逆副作用，Rewind 只记录其保留，不伪造恢复。

Rewind 与 supersede 的区别：

* 新输入覆盖：旧 Intent 进入 superseded，但仍留在历史 path 和展示中；新 Intent 接管执行。
* Rewind：显式缩短 active path，并同步恢复可安全恢复的 Effect；被弹出的 Intent 保持原来的 `completed` 或 `paused` 事实，不应为了表示“离开路径”而改成 superseded。
* 如果 Rewind 恰好撤回了 superseded Intent 的接管者，前一个 Intent 应从 `superseded` 恢复为 `paused`，成为新的 `currentIntentId`；这是撤销接管关系，不是普通执行的逆向跳转。

Fork 不修改来源 Session：

* Reply Fork 只能从 `completed` Intent 的结果边界分出，继承截至该结果的事实，来源 Intent 仍是 completed。
* Input Fork 从某个历史用户输入重新执行，应允许目标为 `paused`、`completed` 或 `superseded`；新 Session 复制目标之前的有效前缀，把目标输入物化为该分支的 paused Intent，并清空目标原有执行事实。
* 从 superseded Input Fork 时，来源分支仍保留“被后继接管”的事实；新分支不存在那个后继，因此目标在新分支中是 paused。这说明 superseded 是分支相关状态，不是跨 Session 的永久标签。
* Intent identity 的作用域是 Session aggregate。若分支复用 Intent ID，完整身份必须是 `(sessionId, intentId)`；若改用新 ID，则必须记录 `originIntentId`。两种方案只能选一种，并保持 artifact、correlation 和审计一致。

## 九、持久化与并发不变量

Session journal 是事实提交边界，revision 必须单调递增，实体集合只追加，已有实体只按
声明的单向状态机转换。Worker 事件必须通过 Session mutation queue 串行处理，并用
Session revision、Worker epoch、Intent ID 和 Operation ID 拒绝迟到或重复事件。

必须保持的跨层不变量：

* 有 `currentIntentId` 时，它必须在历史 path 中，且状态只能是 `running` 或 `paused`。
* superseded Intent 不得在原路径直接获得 current execution，也不得因普通 Send 从历史投影中删除。
* 每个 active-path superseded Intent 必须有明确的接管后继；撤回该后继必须恢复前者的 paused 资格。
* 已暂停 Intent 的 Retry 保留 Intent ID；暂停期间的新输入必须产生新的 Intent ID。
* Tool Operation 的失败必须能被 provider 作为 `isError` tool result 消费；它不能仅凭 `ok:false` 令 Worker 执行 Promise reject 并暂停 Intent。
* Trace 不依赖 provider runtime 是否仍存活；Worker 重启后可由持久化事实重建 Context。
* Renderer 只能消费 Session projection，不拥有领域状态，也不自行解释 raw provider frame。

## 十、当前实现状态

当前实现已具备独立 Intent/Turn/Invoke/Attempt 模型、provider-neutral Context、
Worker epoch/revision 串行化、Effect CAS rewind，以及 ToolCall 错误到 `isError`
provider result 的适配。2026-09-06 已修复暂停后普通新输入删除旧 Intent，以及 Tool Host
的 `ok:false` 直接上浮为 `execution-paused` 两条路径。

但 superseded、Rewind 和 Fork 仍有结构性缺口：当前模型没有显式接管关系；Rewind 会把
弹出的 completed Intent 改成 superseded，却不会在撤回接管者后恢复前一个 paused Intent；
Input Fork 又拒绝 superseded 目标。因而当前代码尚未满足本文件修正后的关系性状态语义。

剩余验证重点是实际 provider 下的 Stop → 新输入、缺失可选 `links.txt`、ToolCall 错误
后的继续循环，以及真实应用重启后的恢复；这些属于运行环境验收，不改变本领域模型。

## 十一、Fork/Rewind 的转换规则

状态转换必须区分“普通命令”与“历史路径操作”。普通命令在同一 Session 内推进
Intent；Rewind 改变同一 Session 的有效 head；Fork 创建新的 Session aggregate。

### 普通前向转换

```text
running ──Stop/运行条件消失──> paused
paused  ──Retry/Continue────> running
paused  ──新输入接管────────> superseded + 新 Intent(running)
running ──最终回复收束──────> completed
```

`paused -> superseded` 必须和新 Intent 的创建在同一个领域提交中完成。superseded
不是删除标记，而是“被哪个后继 Intent 接管”的关系状态。实现可以显式保存
`supersededByIntentId`，也可以由 active path 的相邻关系严格推导；不能两者都没有。

### Rewind 转换

Rewind 的第一步是从 active path 移除 head，第二步才是恢复可逆 Effect：

* 被弹出的 Intent 保持它原来的 `completed` 或 `paused` 状态；离开当前路径不等于 superseded。
* 如果前一个 Intent 是由该 head 接管的 superseded Intent，则撤回接管关系：前一个 Intent 执行 `superseded -> paused`，成为新的 `currentIntentId`，Session 进入 paused。
* 如果不存在被该 head 接管的前任，则 Session 回到前一个 completed head 或 idle；被弹出的 Intent 仍留在历史 graph 和 rewind receipt 中。
* Rewind 不能把任意 superseded Intent 直接改成 paused，只有撤回其明确接管后继时才允许该逆向转换。

示例：

```text
A(paused) --新输入--> A(superseded) -> B(running/completed)
                                     active head = B

rewind B

A(paused), currentIntentId = A
```

多级覆盖按栈式撤回：`A(superseded) -> B(superseded) -> C`，Rewind C 只恢复 B，
再次 Rewind B 才恢复 A。每次撤回都必须校验被撤回 head 正是对应接管者。

### Reply Fork 转换

Reply Fork 创建新 Session，不修改来源 Session：

* 分支点必须是 `completed` Intent 的结果边界。
* 新 Session 继承截至该点的事实和状态，currentIntentId 为空，Session 为 idle。
* 来源 Intent 保持 completed；分支不会把它改成 paused 或 superseded。

### Input Fork 转换

Input Fork 是“从某个历史用户输入重新执行”，不是在来源 Session 内 Retry：

* 目标可以是 `paused`、`completed` 或 `superseded`；`running` 目标必须先停止。
* 来源 Session 完全不变，包括 superseded 状态和原接管关系。
* 新 Session 复制目标之前的有效前缀，目标输入在新 Session 中被物化为 `paused`，清空目标原有 Turn/Invoke/Tool/Effect 执行事实，并设置为 currentIntentId。
* 目标若在来源中是 superseded，来源的后继不被复制，因此新分支中该目标恢复为 paused；这不是来源状态回退，而是新聚合的分支投影。
* 目标若接管了前任，前任与目标之间的接管关系在新分支中仍成立；目标只是暂停等待重新执行。

如果复用 Intent ID，身份必须解释为 `(sessionId, intentId)`；如果要求全局 Intent
identity，则 Input Fork 必须创建新 ID 并记录 `originIntentId`。在身份方案确定前，
不能把两个 Session 中同 ID 的不同状态误认为同一个可变实体。

### 转换不变量

* 普通执行只允许前向状态转换；`superseded -> paused` 仅由 Rewind/Fork 的新聚合视角触发。
* Rewind 不制造 superseded；Fork 不修改来源状态。
* active path 上的 superseded Intent 必须有对应后继；path head 不得是无法解释的 superseded。
* Retry 只能作用于当前 paused Intent；superseded 只能通过 Rewind 恢复或 Input Fork 重放。
