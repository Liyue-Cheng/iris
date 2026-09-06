---
title: agen turn 严重bug
status: In Progress
---
我手工停止，然后打进新的内容继续之后，之前的内容都不见了

还弹出这种信息

**请求已暂停**

ENOENT: no such file or directory, open 'E:\projects\iris\\.iris\issue\2026-09-06-供应商问题.md.assets\links.tx

<br />

.iris/issue/2026-09-03-Iris-Agent-架构设计与本质建模.md

## 状态机链路盘点与本次故障定位（2026-09-06）

### 结论

本次两个表象来自同一条 Agent 执行链上的两个边界错误，并非资产管理器本身把文档内容删掉了：

1. 手工停止后直接发送新消息，会把刚刚暂停的 Intent 标记为 `superseded`，并从 `activeIntentIds` 移除。UI 和下一次 Agent Context 都只投影 active path，因此旧消息、旧回复和旧工具卡片一起消失。
2. Agent 读取不存在的可选 `links.txt` 时，Tool Host 返回 `tool-result ok:false`；Worker 的 `requestTool()` 将该拒绝直接 `throw`，外层 `runExecution()` 把它当成整次执行异常，发出 `execution-paused`。所以普通的 `ENOENT` 被错误升级为“请求已暂停”。

当前没有证据表明 `.iris/issue` 文档或 companion 资产被删除。`links.txt` 是可选关联索引，`src/main/asset-manager.ts` 的读取逻辑对缺失文件会返回空列表；异常发生在 Agent 的通用文件工具链，而不是资产管理器删除路径。

### 现有分级状态机

| 层级 | 当前状态 | 进入/退出要点 | 责任边界 |
| --- | --- | --- | --- |
| Session runtime | `starting`、`ready`、`running`、`waiting-tool`、`retry-wait`、`stopping`、`idle`、`interrupted`、`paused` | `send` 建立 `starting`；Worker ready/run/tool/settled 映射运行态；Stop 先 `stopping` 再 `paused`；完成回 `idle` | 聚合当前是否可接收命令，不承载业务结果 |
| Intent | `running`、`paused`、`completed`、`superseded` | provider/worker/runtime/user 中断进入 `paused`；成功进入 `completed`；新输入调用 `supersedeOpenAgentIntent` 进入 `superseded` | 用户意图生命周期；不应出现 failed |
| Turn | `running`、`settled` | 第一个 provider attempt 创建；最终回复或暂停/重启时 settle | 一轮 invoke + tool calls 的执行事实 |
| Invoke | `running`、`completed`、`failed`、`aborted` | 每次 provider 请求建立；provider attempt 完成/失败/用户 Stop 更新 | provider 执行语义 |
| Invoke Attempt | `running`、`completed`、`failed`、`aborted` | 每次网络尝试独立记录 | 重试细节，不进入 Trace Context |
| Tool Operation | `running`、`completed`、`failed` | Tool Host 返回后结算；异常为 `failed` | 一次世界操作；当前 `failed` 会通过 Worker reject 影响整次执行 |
| Reply activity | `streaming`、`completed`、`stopped`、`failed` | 增量文本建立/追加；Stop 排除；最终 provider message 提交 | UI 可读回复及 Context 是否纳入 |
| Tool activity | `running`、`completed`、`failed`、`canceled` | tool-request 建立；Host 结算；Stop/重启取消 | UI 工具卡片及 effect 关联 |
| Compaction | `running`、`completed`、`failed`、`canceled` | 独立 summary 请求，成功后成为 active policy | Context 折叠，不改 Trace |
| Terminal activity | `running`/`exited`，结果 `success`/`command-failed`/`launch-failed`/`canceled` | PTY 启动、监督、退出；Stop 取消但保留 terminal effect | 外部副作用不可 rewind |
| Renderer card | `running`、`completed`、`failed`、`partial`、`stopped`、`unchanged` | 由 Timeline 投影；只显示 `activeIntentIds` | 展示层，不是事实源 |

领域事件门禁（`src/main/agent/session-events.ts`）对上述实体做追加、不删除和单向状态校验；`session-model.ts` 的 `projectAgentSession()` 再从 `activeIntentIds` 生成 UI。也就是说，active path 是“是否可见、是否进入 Context”的共同闸门。

### 故障一：停止后新输入导致旧内容消失

实际时序：

1. UI Stop 调用 `stopIrisAgent()`，带当前 `expectedIntentId`。
2. `session-manager.ts:521` 的 `stop()` 将 Session 置为 `stopping`，关闭 Worker，再调用 `pauseIntent(..., 'user', ...)`。
3. `pauseActiveAgentIntent()` 将 Intent 置 `paused`，Reply 置 `stopped/excluded`，Turn settle；此时旧内容仍在 `activeIntentIds`，所以单独点“继续”是正常的。
4. 用户直接输入新消息进入 `sendSession()`。`session-manager.ts:323-326` 检测 `session.state === 'paused'`，调用 `supersedeOpenAgentIntent()`。
5. `session-domain.ts:173-183` 将旧 Intent 置 `superseded`，并执行 `activeIntentIds.filter(...)` 将其移除。
6. 新 Intent 被 append 到 active path。`projectAgentSession()` 只对 active path 做 `visibleIntents`，所以旧 Intent 从 renderer patch 中收到 `remove`；`buildAgentTrace()` 也只读 active path，所以新 Worker 的 history 同样不包含旧 Intent。

这不是“渲染丢帧”，而是持久化状态被明确改成了不可见的 superseded。当前测试只验证了 Stop 后 Retry 同一 Intent（`session-manager.test.ts:273`），没有验证 Stop 后 Send 新输入，因此该行为没有被测试捕获。

与核心设计文档的关系：文档允许“被下一个输入覆盖”，但“覆盖”目前同时承担了分支选择、历史可见性和 Context 截断三个语义。用户期待的是“停止后继续追加新消息”，而实现选择了“覆盖并从有效路径删除”，两者契约不一致。至少需要把“新输入分支”与“历史可见性”拆开：旧 Intent 可以离开当前执行路径，但不能从本次会话的展示历史和可审计 Trace 中静默消失；若确实要截断 Context，也应提供明确的 branch/rewind 语义而不是普通 Send 隐式完成。

### 故障二：可选 `links.txt` 的 ENOENT 被升级为暂停

实际时序：

1. Agent provider 通过 `read` 工具请求 `<doc>.assets/links.txt`。该索引文件不存在是合法情况；`asset-manager.ts:433-439` 已把同类缺失处理为空列表，但 Agent 通用工具没有复用此语义。
2. `IrisAgentToolHost.execute()` 捕获 `fs.readFile()` 的 `ENOENT`，将 Tool Operation/Activity 标为 `failed` 并返回错误文本（`tool-host.ts:64-89`、`110-127`）。
3. `settleToolOperation()` 将失败发为 `tool-result { ok: false, error }`（`session-manager.ts:1325-1333`）。
4. Worker 的 `settleTool()` 对 `ok:false` 执行 `pending.reject(new Error(message))`；`prepareExecution()` 的 `executeToolCall` 没有把该拒绝转成带 `isError:true` 的 tool result，而是让异常离开 provider 执行（`agent-worker.ts:282-298`、`574-580`）。
5. `runExecution()` 捕获异常并发出 `execution-paused`（`agent-worker.ts:193-231`）。Manager 再调用 `pauseSessionExecution()`，于是 UI 显示“请求已暂停”和原始 ENOENT。

这违反核心设计文档的错误归层原则：确定性 ToolCall 的不可重试错误应成为该 ToolCall 的错误结果，让模型决定如何继续；只有 Invoke 反复不成功才应使 Intent 暂停。当前 `ok:false` 的协议语义却是“让整个 provider Promise reject”，因此所有文件不存在、权限拒绝、参数错误都有机会污染 Session/Intent 生命周期。

### 与核心设计的符合度

已经符合：

- Intent 已是独立实体，invoke/attempt 的失败没有写入 Intent 的 failed 状态。
- Turn 只有 `running/settled`；Trace 由 active Intent path 和 Turn 事实构成，Context 通过纯函数投影。
- Worker epoch、Session revision、命令串行队列能抑制 Stop/Worker 尾事件的竞态。
- `asset-manager` 对可选 `links.txt` 的磁盘读取本身是容错的；文件 effect 也保留了 CAS rewind 所需的 before/after 信息。

偏差或风险：

- 普通 Send 隐式调用 supersede，导致“覆盖”同时删除 UI 历史和 Context 历史；这是本次内容消失的直接原因。
- ToolCall 的 `ok:false` 没有在 Worker 适配层转换为模型可消费的 error tool result，而是上浮成 `execution-paused`；这是 ENOENT 暂停的直接原因。
- Intent 当前还保留 `completed`，而文档前半段的理想模型只写 `running/paused/被覆盖`；后半段实现记录已接受 `completed`。需要在设计文档中统一术语，避免“完成”和“被覆盖”在产品行为上混淆。
- 领域层、Worker 协议和 UI 卡片各自有一套状态，当前没有一张可执行的跨层 transition contract；因此单层测试全绿仍不能保证“Tool 失败不暂停”“Stop 后 Send 保留历史”这类跨层不变量。

### 建议的修复顺序（本次仅完成定位）

- [ ] 先补回归测试：Stop 后 Send 新输入，断言旧 Intent 仍可见/可审计，并明确它是否进入新请求 Context；同时覆盖 renderer 增量 patch 不发送旧 Intent remove。
- [ ] 明确“继续追加”与“输入分支/覆盖”的产品语义。建议普通 Send 在 paused Intent 上追加新的 Intent 并保留旧 Intent 的 session history；只有显式 Input Fork/Rewind 才改变 active Context 前缀。
- [ ] 在 Worker `executeToolCall` 边界把 `ok:false` 变成 provider tool result（`isError: true`、保留错误文本），让模型自行决定重试/换路径；仅 provider 层反复失败才发送 `execution-paused`。
- [ ] 对可选 companion 文件增加专门的工具语义或读取白名单：缺失 `<doc>.assets/links.txt` 返回空内容/空关联，不把正常缺失当作异常；权限拒绝等真实错误仍保留为 ToolCall error result。
- [ ] 建立跨层状态契约测试矩阵：Session×Intent、Intent×Turn、Invoke×Attempt、ToolOperation×Worker、Timeline×Projection，至少覆盖 Stop、Retry、Send、Input Fork、Rewind、Restart、Tool ENOENT/权限错误。
- [ ] 修复后再更新核心设计文档，把“superseded 是否从可见历史消失”和“ToolCall 错误是否暂停 Intent”写成明确不变量。

验证记录：`npx vitest run src/main/agent/session-manager.test.ts src/main/agent/tool-host.test.ts --pool=forks --poolOptions.forks.singleFork=true`，34/34 通过。现有测试通过不代表本次链路正确，因为缺失上述两个跨层场景。

## 修复结果（2026-09-06）

已完成本 issue 两条故障链的代码修复：

* `supersedeOpenAgentIntent()` 不再从 `activeIntentIds` 删除被覆盖 Intent。`superseded` 现在只表示执行权转移，旧 Intent 继续保留在历史 Trace、Session 投影和后续 Context 中；`currentIntentId` 仍是唯一执行主导权。
* 暂停态新输入会在 anchor/prompt 预检和 compaction 成功后才提交 supersede，预检失败不会破坏原来的 paused Intent。
* 领域聚合校验允许 superseded Intent 留在历史路径，显式 Rewind 仍通过弹出路径末项实现截断，不改变原有 Rewind 语义。
* 新增回归测试覆盖“Stop 后 Send 新输入”：旧 Intent 显示为 `superseded`、新 Intent 为 `running`，新 Worker history 保留旧用户输入。
* superseded Intent 不再显示输入分支入口；输入分支仅对 `paused`/`completed` Intent 可用，与领域 API 的可分支状态一致。
* Worker `executeToolCall` 边界捕获 Tool Host 的 `ok:false`，转换为带 `isError: true` 的 provider tool result。文件不存在、权限拒绝等确定性 ToolCall 错误不再直接升级为 `execution-paused`；只有 provider/invoke 层失败才暂停 Intent。

验证：

* `npm run typecheck -- --pretty false` 通过（含 `check:async`）。
* `npx vitest run src/main/agent --pool=forks --poolOptions.forks.singleFork=true` 通过：12 个文件、116 项测试全部通过。
* 未运行 build、dist、开发服务器或截图。

- [ ] 人工验证真实 provider 在缺失 `links.txt` 时收到 `isError` tool result 并继续执行。

## 四态 Intent 语义校准与修复方向（2026-09-06）

这里的 `superseded` 不是普通词义上的“被删掉”“无效”“失败”，而是 Intent 的第一公民状态。四态应理解为：

| Intent 状态 | 语义 | 是否还能继续执行 | 是否仍是会话事实 |
| --- | --- | --- | --- |
| `running` | 当前意图正在被推进，可能处于 provider 调用或工具循环中 | 是 | 是 |
| `paused` | 当前意图的推进条件暂时不存在，或用户主动停止；意图本身未被否定 | 是，通过 Retry/Continue | 是 |
| `superseded` | 暂停期间用户提交了新的输入，新的意图接管后续推进方向；旧意图不是失败，而是被新意图覆盖 | 否，不能再原地 Retry；如需继续旧方向，应显式分支 | 是，必须可追溯、可展示 |
| `completed` | 当前意图已经完成了它所承担的工作，正常收束 | 否；如需新工作应新建 Intent | 是，属于正常历史 |

因此，`superseded` 是一种“生命周期归属变化”，不是一种“数据可见性变化”：它应该失去 `currentIntentId` 的执行主导权，但不能因此从 Session 的历史、UI 展示或审计 Trace 中消失。当前代码在 `supersedeOpenAgentIntent()` 中同时做了状态迁移和 `activeIntentIds.filter(...)`，把这两个概念绑定在了一起，才造成了“状态正确但内容消失”的错觉。

### 我对四态转换的理解

允许的核心转换应是：

```text
running ──成功收束──> completed
   │
   ├─暂停/停止/运行时暂不可继续──> paused ──Retry──> running
   │                                  │
   │                                  └─新输入接管──> superseded
   │
   └─（若产品允许运行中直接被新输入取代）────────────> superseded
```

`superseded` 和 `completed` 都是不可回到 `running` 的收束态，但原因不同：前者表示“后续方向被替换”，后者表示“原方向完成”。`paused` 是唯一保留原地继续语义的非运行态；新输入不是 Retry，而是创建新的 Intent，并使旧 Intent 进入 `superseded`。

### 修复方案

1. **拆开执行路径与历史路径。** 保留 `currentIntentId` 作为唯一执行主导权；普通 Send 在 paused Intent 上创建新 Intent，并把旧 Intent 转为 `superseded`。但 `projectAgentSession()` 不再只用 `activeIntentIds` 决定可见历史，应从一个明确的 session history/view path 投影四态 Intent；旧 Intent 显示为“已被后续输入覆盖”，而不是收到 remove patch。

2. **明确 Context 规则。** 新 Intent 是否继承旧 Intent 的 Context 必须由产品语义决定，不能借 `activeIntentIds.filter()` 隐式决定。建议普通 Send 继承此前有效对话事实，但把旧 Intent 标记为 superseded；只有显式 Input Fork/Rewind 才截断 Context 或创建独立分支。这样“覆盖执行权”和“删除上下文”不再是一件事。

3. **让 Trace 保留四态事实。** `buildAgentTrace()` 应保留已发生的 superseded Intent 及其 settled Turn；Context 再根据有效执行分支策略选择是否发送给模型。这样可以同时满足：UI 不丢记录、审计可追溯、模型上下文可按策略裁剪。

4. **增量投影使用状态更新而不是删除。** `diffAgentSessionProjection()` 对 paused → superseded 的旧 Intent 应生成 header/card 状态更新；只有显式 rewind/branch 截断时才从当前展示集合移除。这样 renderer store 不会把“被覆盖”误解释成“实体不存在”。

5. **把 ToolCall 错误另行修复。** `superseded` 语义调整不能掩盖 ENOENT 链路：Worker 仍需把 `ok:false` 转成模型可消费的 `isError` tool result，只有 Invoke 层反复失败才让 Intent 进入 `paused`。

6. **补四态契约测试。** 至少覆盖 `running → paused → running`、`paused → superseded`、`running → completed`、superseded 历史投影不删除、superseded 不可 Retry、显式分支可从 superseded 之前的事实创建新路径，以及新输入后的 Context 内容。

这里的修复目标不是让所有 Intent 永远出现在模型 Context，而是让状态语义保持正交：`superseded` 决定谁拥有后续执行权，`Trace/Context` 决定哪些历史事实展示或发送，`completed` 决定是否正常收束。三者不能再由一个 `activeIntentIds` 数组同时代替。

## 二次审计：Rewind/Fork 暴露的 superseded 缺口（2026-09-06）

前一轮只修复了“普通 Send 不删除 superseded 历史”，但四态语义仍未闭合：

* `truncateIntentChain()` 把任何被 Rewind 弹出的 Intent 都改成 `superseded`，包括已经 `completed` 的 Intent。这是用生命周期状态代替路径成员关系。
* 场景 `A(paused) -> B 接管` 中，A 成为 superseded。Rewind B 后，当前实现只留下 `A(superseded)`，不会恢复为 `A(paused)`，也不会恢复 `currentIntentId=A`，因此无法 Retry A。
* Input Fork 明确拒绝 superseded Intent，导致“从被覆盖输入重新开始”没有合法操作；此前把 superseded 的分支按钮隐藏只是掩盖领域缺口。
* 模型没有保存 `supersededByIntentId` 或等价关系，无法验证某个 superseded Intent 是由谁接管，也无法精确判断 Rewind 是否撤回了接管者。

修正后的语义是：superseded 表示“在当前有效路径上被明确后继接管”，它是分支相关的第一公民状态。Rewind 移动 active path，不应把被弹出的 completed/paused Intent 改成 superseded；若撤回的正是接管后继，则前一个 superseded Intent 恢复为 paused 并重新获得继续资格。Fork 创建新的 Session 视角，不修改来源状态；Input Fork 应允许 paused/completed/superseded 输入，并在新分支中把目标输入物化为 paused。

- [ ] 为 Intent 增加可验证的接管关系（如 `supersededByIntentId`），并规定与 active path 相邻关系的一致性。
- [ ] 修正 Rewind：保留被弹出 Intent 的生命周期状态；撤回接管者时执行 `superseded -> paused` 并恢复 current Intent。
- [ ] 修正 Input Fork：允许 superseded 目标，在新 Session 中恢复目标输入为 paused，来源 Session 保持 superseded。
- [ ] 恢复 superseded Input Fork 的 UI 能力，并以领域投影决定可用性。
- [ ] 增加 `A paused -> B -> rewind B -> A paused -> retry`、completed rewind、superseded input fork 和来源分支不变测试。

## 方案收敛：Trace 与人工操作面（2026-09-06）

经过重新讨论，Fork/Rewind 采用最小领域模型，不再引入额外的路径审计层或副作用回滚层。

### 当前共识

* Trace 只描述 Agent 流程面：用户输入、Intent、Turn、assistant 回复和 tool result 等已经发生的流程事实。
* Fork 与 Rewind 属于人工操作面，不是 Trace 中的流程实体；Trace 不需要知道“发生过 Fork”或“发生过 Rewind”。
* Rewind 的结果就是直接截断当前 Trace 的尾部，使当前会话回到指定的历史前缀。
* Fork 的结果就是从某个 Trace 前缀创建一个新的 Session/Trace 视角；来源 Session 和来源 Trace 不被修改。
* 暂不记录 Rewind/Fork 审计信息，不记录独立 Effect Ledger，也暂不实现文件、目录或终端副作用回滚。
* 因此当前 Rewind 只是 Agent 认知流程的回退，不代表现实世界已经恢复；后续 Agent 需要重新检查外部状态。

### 简化后的边界

```text
Trace（Agent 流程面）
  ├─ Intent
  └─ Turn / Reply / Tool result

人工操作面
  ├─ Rewind：截断 Trace 尾部
  └─ Fork：复制 Trace 前缀到新 Session
```

`superseded` 仍然只用于表达“新输入接管了暂停中的旧 Intent”。它不是 Rewind 的删除标记，
也不是 Effect 或审计状态。Rewind 截断后，被移除的尾部不再属于当前 Trace；如果前一个 Intent
因此重新成为当前可继续节点，则按当前 Intent 状态规则恢复为 `paused`。

## 最小方案实现结果（2026-09-06）

已按上述收敛方案完成实现：

* Rewind 只截断当前 `activeIntentIds` 尾部，即直接缩短当前 Trace；不再把被截断 Intent 改成 `superseded`。
* Rewind 不创建或追加 `rewindReceipts`，不调用文件/目录/终端副作用恢复逻辑。
* 当截断后新的 Trace head 是 `superseded` Intent 时，将其恢复为 `paused` 并重新成为当前 Intent；否则会话回到 idle。
* Input Fork 可从 `paused`、`completed`、`superseded` 输入创建新 Session，来源 Session 不变。
* 旧 Session 中的 effect 字段仅为兼容读取保留；新执行不再向 Session 追加 effect ledger，人工 Fork/Rewind 也不读取、不恢复这些数据。

验证：`npm run typecheck -- --pretty false` 通过；`npx vitest run src/main/agent --pool=forks --poolOptions.forks.singleFork=true` 通过，
12 个文件、118 项测试全部通过。
