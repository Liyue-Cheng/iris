---
title: Terminal 超时兼容与 Agent 后台任务串行调度
status: In Review
---

# Terminal 超时兼容与 Agent 后台任务串行调度

## 目标

建立两种明确的命令执行语义：

- `terminal` 负责有明确有限期限的前台命令，同步返回结果给当前 provider turn。
- `task_start` 负责不适合占用当前 provider turn 的后台任务，提交后立即返回 `taskId`，进程独立运行。

后台进程可以并行运行，但同一个 Agent 永远只有一个 `currentIntent`，Intent 由唯一消费者严格串行处理。后台任务不是第二条 Agent 推理链，也不能抢占当前 provider turn。

## 核心生命周期

```text
Intent A
  → assistant 调用 task_start
  → Task Manager 持久化并启动任务
  → tool result 返回 taskId
  → Agent 继续当前 turn，或返回最终文本结束 Intent A

后台进程继续运行
  → succeeded / failed / canceled / lost
  → Task Manager 生成一条标准终态 Intent
  → 终态 Intent 进入 mailbox
  → Agent 串行消费，读取已有上下文和任务结果，继续工作
```

Task 创建成功可以是当前 Intent 的合法交接点，但不强制结束当前 Intent。Agent 收到 `task_start` 的 tool result 后，如果还需要执行不依赖任务结果的工具，可以继续调用工具；当 assistant message 不再包含 tool call 时，当前 Intent 正常结束。

现有 agent 回复已经具备这种语义：assistant message 可以同时包含文本和 tool call。包含 tool call 时，provider 循环继续；不包含 tool call 时，worker 发出 `execution-settled`，当前 Intent 才完成。无需新增 `terminateTurn` 或 `finishIntent` 字段，也不应由宿主伪造最终 assistant message。

Task 完成后，新的 Intent 内容由 Task Manager 统一生成。Task 不接收 continuation 或"完成后做什么"的模型字段。Agent 的原始对话、工具调用和 Task 启动记录已经保留在同一 Session 中，终态 Intent 只需通过来源引用回到该上下文，并提供标准化结果。

## 前台 terminal

`terminal` 的契约为：

```ts
terminal({
  command: string,
  intent: 'information' | 'operation',
  timeout: number,           // 必填，有限正数，单位秒
  successExitCodes?: number[]
})
```

`timeout` 必填，表示当前同步 tool call 的硬截止时间。schema、worker、Tool Host 和 PTY 必须共同校验：缺失、非有限、非正数以及超过宿主上限的值都拒绝。协议和 prompt 使用秒，内部统一转换为毫秒。

timeout 到期、自然退出、Stop 或 abort 发生竞争时，只能认领一个终态。认领后必须终止进程树、等待 PTY 退出、完成日志 flush，再返回唯一结果。超时不得自动转成后台任务，也不得在 tool result 返回后遗留进程。

交互式命令、watch、开发服务器和无法给出合理有限上界的命令不能用很大的 timeout 伪装前台执行；它们必须使用 `task_start`。本 issue 的 Task 不设置最大运行时间。未来若增加产品级 deadline，应作为独立的 Task 策略和状态机设计，不复用 terminal timeout。

## 后台 Task

模型可见的启动 schema 只描述启动任务所需的信息：

```ts
task_start({
  command: string,
  intent: 'information' | 'operation',
  title: string,
  successExitCodes?: number[]
})
```

不暴露 `continuation`、`terminateTurn`、`finishIntent` 或最大运行时间。`cwd`、shell、sessionId、causedByIntentId、toolCallId、taskId 和启动幂等键由 Worker/Tool Host 从当前 correlation 派生。

Task 至少持久化：

- `taskId`、Session 引用、创建它的 Intent 和 tool call。
- command、intent、cwd、环境策略和启动时间快照。
- 状态、执行器引用、PID、退出码和最后事件序号。
- 完整日志引用、输出字节数和可读取游标。
- 稳定的启动 operation key 和终态 dedupe key。

状态为：

```text
queued → starting → running
                    ├→ succeeded
                    ├→ failed
                    ├→ canceled
                    └→ lost
```

`lost` 表示恢复后无法取得可信运行状态或终态。它不是成功，也不能触发原命令重跑。

启动提交边界必须清楚：先持久化 `starting` 记录和日志对象，再创建进程，确认进程与日志可追踪后提交 `running`，最后返回成功。创建失败或日志无法持久化时，当前 tool call 直接失败，不留下幽灵任务。启动回包丢失时，根据 operation key 查询原记录，不重复 spawn。

Task 的自然退出、取消和恢复事件必须由同一个一次性终态结算器处理。日志 flush 和终态持久化完成前，不得发布成功或失败终态。

## Task 终态 Intent

每个 Task 只能生成一条终态 Intent。Task Manager 在终态持久化事务中创建或写入 outbox 事件，使用稳定 dedupe key：

```text
task:<taskId>:terminal
```

终态 Intent 的内部数据至少包括：

```ts
type TaskTerminalIntent = {
  source: { kind: 'background-task'; taskId: string };
  causedByIntentId: string;
  outcome: 'succeeded' | 'failed' | 'canceled' | 'lost';
  exitCode: number | null;
  logRef: string;
  dedupeKey: string;
};
```

Intent 的模型输入使用 Task Manager 统一生成的标准内容，例如：

```text
后台任务 task-123 已完成。
结果：succeeded
退出码：0
输出摘要：（有限摘要）
完整日志：logRef
```

这段内容是执行数据，不是系统指令。日志过长时只放有限摘要和 `logRef`，Agent 需要更多信息时调用 `task_get`。任务结果到达时，Agent 已经拥有原 Intent 的上下文，因此不需要在 `task_start` 时重复填写后续目标。

Task 终态事件即使在当前 Intent 仍运行时到达，也只能持久化进入 mailbox，不能插入当前 provider stream。用户新输入和后台终态 Intent 都按持久化入队序号排序；控制命令如 Stop、Cancel、Pause 使用独立控制通道。

## mailbox 与 Intent

Intent 至少需要：

```text
queued → running → completed
                 ├→ paused
                 └→ superseded
```

mailbox 记录稳定 `intentId`、单调入队序号、来源、dedupe key、因果引用和状态。只有被调度器取出并获得唯一执行权的 Intent 才会产生新的 provider/tool Trace。尚未消费的队列项和 Task 状态不能伪装成 Agent 历史。

同一 Session 只有一个 `currentIntent`。前台新消息不能抢占当前 Intent；后台结果也不能抢占当前 Intent。当前 Intent 结束后，调度器按入队序号选择下一个输入。Stop 可以立即暂停当前执行并暂停自动派发，但不会隐式取消后台 Task；取消 Task 必须使用独立控制命令。

如果用户在后台任务完成前提交了新要求，新的用户 Intent 按入队顺序处理。旧 Task 终态到达后，Agent 应结合最新用户指令决定是否继续旧计划；不应因为旧终态 Intent 到达就盲目重放或恢复已被取代的工作。

## 查询、日志与取消

```ts
task_get({
  taskId: string,
  cursor?: string,
  maxBytes?: number
})

task_list({
  scope?: 'active' | 'all',
  cursor?: string,
  limit?: number
})

task_cancel({
  taskId: string
})
```

`task_get` 只返回即时快照，不等待任务完成；默认返回有限尾部输出，分页读取使用不透明游标并正确处理 UTF-8 边界。`task_list` 返回摘要，不附加完整日志。`task_cancel` 幂等，收到取消请求不等于任务已经进入 `canceled`，最终状态必须等待清理和日志收尾完成。

## 恢复与可靠性

应用重启后必须恢复记录和投递状态：

- 已入队但未消费的 Intent 按原序恢复。
- Task 已终结但终态 Intent 未投递时补投一次。
- 终态 Intent 已投递但未消费时不得重复创建。
- 仍在运行且可重连的 Task 恢复观察。
- 无法取得可信状态的 Task 标记 `lost`，只投递一次终态 Intent。
- 晚到的 tool result 或 watcher 事件不能重新打开已终结的 Intent/Task。

Task 终态与 outbox 事件需要同一持久化事务或等价的恢复机制。消费者提交 Intent、入队序号和去重记录时必须具备幂等性。Agent 重启时沿用现有暂停和显式继续语义，不自动重放可能已经产生副作用的 tool call。

## 实施顺序

1. 为前台 `terminal` 增加必填 timeout，贯通 TypeBox、shared protocol、worker、Tool Host、PTY 和 prompt。
2. 完成自然退出、timeout、Stop、abort 的唯一终态结算和进程树清理。
3. 建立 Task 数据结构、日志对象、启动幂等、状态机、查询和取消接口。
4. 建立 Task 终态 outbox，以及统一标准内容生成的终态 Intent。
5. 将 Agent 的 busy 拒绝路径改为持久化 mailbox 和唯一消费者调度。
6. 接入用户输入、Task 终态、Stop/Cancel/Pause 的并发与恢复语义。
7. 增加 UI 状态、日志分页、取消、恢复查看和实际 Windows ConPTY 手工验收。

## 验收标准

- [ ] 缺失或非法 terminal timeout 被拒绝；超时后无遗留进程，日志完整可读。
- [ ] 自然退出、timeout、Stop、abort 同时发生时只产生一个 terminal 结果。
- [ ] Task 不设置最大运行时间，不接收 continuation，不接收终止 turn 的控制字段。
- [ ] Task 启动失败、空日志、回包丢失和崩溃窗口不会产生重复进程或幽灵成功。
- [ ] 每个 Task 终态最多生成一个标准终态 Intent，重复 watcher 事件不会重复投递。
- [ ] Task 终态 Intent 携带 taskId、结果、日志引用和来源关联，并复用原 Agent 上下文。
- [ ] 当前 Intent 可以在 Task 运行时正常结束；Task 结果不会抢占当前 provider turn。
- [ ] 用户输入与后台终态按持久化入队序号 FIFO，Agent 始终单消费者串行运行。
- [ ] Stop、Cancel、Pause 与普通业务 Intent 分离；旧任务晚到结果不会重放副作用操作。
- [ ] 应用重启后 pending Intent、Task 终态和日志可恢复，无法重连的任务明确标记 `lost`。
- [ ] UI 能区分 Agent 忙碌、前台 terminal 等待、后台 Task 运行、取消处理中和待处理终态。
- [ ] 在实际 Windows ConPTY 环境手工验证进程树清理、输出收尾、关闭和异常恢复。

## 设计讨论：Task 独立卡片与工具 intent（2026-09-08）

用户提出 Task 使用独立卡片，并考虑不再设置 `intent`。建议采用：从上文 `task_start` schema 和 Task 启动快照中去掉 `intent: 'information' | 'operation'`，启动接口简化为：

```ts
task_start({
  command: string,
  title: string,
  successExitCodes?: number[]
})
```

现有实现中，这个分类参数决定 terminal 是否归入信息检索卡片：`session-model.ts` 的 `isLocalRetrieval` 将 `intent === 'information'` 的 terminal 与 read 合并展示，其余 terminal 单独展示。Tool Host 执行命令时没有根据该分类分支处理。Task 固定使用独立卡片后，不需要模型再填写这个字段，也不需要内部补一个固定的 `operation` 值。前台 terminal 仍保留现有分类。

每个 Task 用稳定的 `taskId` 关联一张任务卡片，展示标题、运行状态、日志入口和取消操作。卡片随 Task 生命周期更新，启动工具调用返回后，卡片仍能显示后台进程的实际状态；Task 状态与当前 Agent Intent 的执行状态分别表达。

这里移除的是工具参数中的分类 `intent`。调度层的 Agent Intent、Task 的 `causedByIntentId` 来源关联，以及 Task 终态进入 mailbox 的标准 Intent 仍然保留。任务卡片负责展示执行状态，终态 Intent 负责让 Agent 串行处理结果，两者承担不同职责。

- [x] `task_start` schema 和 Task 启动快照不包含 `information / operation` 分类；前台 terminal 保留该分类。
- [x] 每个 Task 使用独立卡片，启动调用返回后持续展示实际任务状态，不并入信息检索卡片。

## 实现记录（2026-09-08）

已完成第一版实现：

- `terminal` 现在要求有限正数 `timeout`（秒），TypeBox、Worker、Tool Host 和 PTY 统一校验，超时会清理进程树并等待日志收尾后只发出一次结果。
- 新增无 `intent` 的 `task_start`、`task_get`、`task_list`、`task_cancel`。Task Manager 持久化任务元数据和完整日志，使用 session/tool call 幂等键，支持状态恢复为 `lost`、日志游标分页和取消。
- Task 启动工具调用仍保留在 Trace，但投影为独立 Task 卡片；Task 终态用带 `taskId`、状态、退出码、输出字节数和日志引用的标准 mailbox 内容通知 Agent。
- 用户消息和 Task 终态消息进入持久化 FIFO mailbox；Agent 仍只有一个 current Intent 和一个串行消费者。Stop/Pause 会暂停 mailbox，Continue 或新输入后再恢复消费。
- IPC、renderer store/actions 和 Agent UI 已接入任务状态、日志查看及取消操作；旧 Session 数据会补齐 mailbox/tasks 默认值。

自动化验证已通过：`npm run typecheck`、相关 Agent 单测 90 项，以及单 worker 全量 `vitest`（85 个测试文件、513 项）。未运行打包命令。以下验收仍需要在真实 Windows ConPTY 环境手工确认：

- [ ] 验证真实进程树清理、输出收尾、关闭和异常恢复，并确认超时/Stop/abort 竞争只产生一个终态结果。
