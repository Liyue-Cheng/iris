---
title: Codex 的 Intent 与后台任务行为调研
status: Active
---

# 调研范围与版本

本报告结合本机 Codex CLI 0.146.1、官方 Codex changelog 搜索索引（截至 2026-09-07 可见到 0.148.x 及后续提交条目）和 `codex --help`。Codex local TUI/exec、Codex Cloud task、App/host 连接是不同层次，不能混成一个机制。

# 可证实来源

- 官方 Codex 文档入口：<https://developers.openai.com/codex/>；变更记录索引：<https://learn.chatgpt.com/docs/changelog>。
- 本机 `codex --help`：`codex exec resume` 可恢复本地会话；`codex cloud exec/status/list/apply/diff` 提交和查询独立云任务；`codex app-server` 提供宿主连接；`codex fork`、`archive/unarchive` 管理会话生命周期。
- 官方 changelog 索引条目：`Add durable user-message queue dispatch`、`Simplify queued user message admission`、`Add interrupted turn recovery`、`Keep response streams alive through connection failures`、`Add running-task exit choices to local daemon sessions`、`Add experimental thread queue APIs to app server`、`Use thread configuration for app/read`、`Track running unified exec processes at turn completion`。
- 移动/宿主相关条目还提到 queued prompts 与 connected host 同步、可编辑、后台发送；running tasks、unread updates、tasks awaiting response 的 Priority view；断线重连修复 stale task updates、missing approvals 和 stuck Send。

这些证据说明 Codex 正在把“用户输入、运行中的 turn、后台执行、恢复/重连”做成持久化状态机，但 changelog 没有公开一个简单的“后台事件永远优先/用户永远优先”规则。

# 输入与后台事件时序

Codex 的可观察模型更接近：

```text
用户消息/编辑中的 queued prompt
             ↓ durable admission
Thread/turn queue ──→ 当前 turn 消费
             ↑                 ↓
后台 unified exec / task 状态 ──→ 完成、失败、审批、未读更新
```

前台输入可以在 TUI 初始化或当前回合运行时先进入队列；官方条目明确提到 composer 在启动期间保持可编辑，以及 durable user-message queue dispatch。后台任务有独立运行状态和退出选择，不等于把输出直接拼到当前模型流中。

# Priority、queue、interrupt、resume

- Queue：用户消息具有 durable queue admission；queued prompt 可与 connected host 同步并编辑，发送失败的消息需要后续重新投递。`Simplify queued user message admission` 表明入队有明确的准入层，而非简单追加字符串。
- Priority：产品层提供 running tasks/unread updates/tasks awaiting response 的 Priority view，这是展示和处理优先级视图，不等于普通业务消息可以任意抢占当前 turn。
- Interrupt：有 `interrupted turn recovery` 和 code-mode cell interrupt 条目，说明中断会形成可恢复状态；模型设置更新不会改变 active turn midstream，表明活动 turn 具有稳定边界。
- Resume/reconnect：本地 `exec resume`、TUI resume/fork、响应流连接恢复、MCP/host 重连和持久化 cwd/approval policy 共同保证恢复后继续原 thread，而不是重跑原 prompt 或丢失队列。
- Background task completion：`running-task exit choices` 和 unified exec tracking 表明任务完成/退出是独立状态；未见官方证据表明它会无条件抢占正在消费的用户消息。

# Trace 与 queue 边界

Codex 的 changelog 同时出现 thread/turn、rollout/history、queued user message、running task 等概念，说明它们不是同一层事实：

- Thread/rollout history 记录已发生的会话和模型执行事实。
- queued user message 是待消费输入，支持持久化、编辑、取消或重新投递。
- running unified exec 是宿主执行状态，可在 turn 完成时继续追踪。
- unread updates/priority view 是 UI 聚合，不应直接当作模型上下文。

这与 Iris 的“Trace 只记录已执行事实，pending queue 由 Agent 层管理”高度同构。

# 与 Iris 的对照

相似点：严格的 turn 边界、持久化输入队列、后台执行状态独立于会话文本、断线恢复、取消/编辑未投递消息、运行任务的显式退出选择。

差异点：Codex 同时支持云任务、local daemon、app-server 和多宿主同步，状态面更复杂；Iris 当前只需围绕单 Agent mailbox 建立统一语义，不需要复制 Codex 的云任务产品面。

# 可吸收设计

- 为普通 Intent 增加 durable admission：入队即生成 ID、来源、幂等键和顺序号，发送失败可重试。
- 将 queued、running、awaiting-input、completed、failed、canceled 区分开；不要用一个“后台中”布尔值。
- 当前 turn 的模型/策略快照保持稳定；新设置和新 Intent 不得半途改变 active turn。
- 支持“编辑/取消尚未投递的消息”，但一旦消费就只能通过新的 Intent 修正。
- 将 task completion、unread update、approval request 投影到 Agent mailbox；UI priority view 只做观察和显式控制。
- 做好 interrupted turn recovery、重连后的去重和未读事件恢复。

# 不应照搬的设计

- 不要把 Codex Cloud task、local `exec resume` 和 app-server queue 当作一个 API。
- 不要为了追求“实时”而让后台事件直接插入 provider stream；这会破坏 Trace 顺序和幂等性。
- 不要把 priority view 误解为普通 Intent 的隐式抢占规则；控制命令（Stop/Cancel/Pause）可单独走高优先级通道。

# 证据边界

官方 changelog 搜索结果是 `learn.chatgpt.com/docs/changelog` 的索引内容，当前环境无法稳定直接抓取完整页面，因此本报告引用的是可见条目和本机 CLI 帮助，不声称已读取 Codex 内部源代码。具体 FIFO 细节、多个 queued message 的合并规则和后台完成事件是否自动生成 user message，仍需通过 app-server 协议或黑盒测试进一步确认。
