---
title: DeepSeek Harness 的 Intent 与后台任务行为调研
status: Active
---

# 调研范围与结论

本报告核查截至 2026-09-07 能公开验证的 DeepSeek 资料，问题聚焦于：一个模型回合运行时，前台新输入、后台任务完成事件或外部 Agent 事件同时到达时，系统如何排序、排队、打断和恢复。

需要先划清范围：DeepSeek 官方公开的是模型/API 与产品能力说明，并没有像 Codex CLI 或 Claude Code 那样公开一个可审计的本地 agent harness、事件协议或后台任务队列实现。本机也未发现名为 DeepSeek Harness 的官方 CLI/SDK 源码。因此下面不能把社区仓库、第三方桌面应用或“DeepSeek 模型被某个 harness 调用”的行为冒充为官方行为。

# 可证实来源

- DeepSeek API 文档入口：<https://api-docs.deepseek.com/>。公开文档描述消息列表、工具调用和流式响应，但没有公开一个跨请求的后台任务 mailbox 或前台输入优先级协议。
- GitHub 可检索到 `awesome-deepseek-harness`、`dsh-desktop`、`dsh-agent-teams` 等社区项目，但它们是第三方 harness，不能代表 DeepSeek 官方运行时。
- 未找到官方文档明确规定“后台结果抢占当前用户输入”“新用户消息覆盖旧消息”或“后台完成自动注入同一 Trace”。

# 输入与后台事件时序

在公开资料允许确认的最小模型中，DeepSeek API 只看到客户端提交的一次请求及其上下文：

```text
客户端提交 messages/tools
        ↓
DeepSeek 返回流式或非流式响应
        ↓
客户端决定是否继续下一轮、如何处理 tool result/外部事件
```

因此，若某个产品支持后台 shell、子 Agent 或定时任务，队列与优先级必然属于产品 harness 层，而不是已公开的 DeepSeek 模型协议。后台任务完成后是：

1. 作为下一轮 user/developer/tool message 追加；
2. 作为通知展示但不喂给模型；
3. 触发新会话/新 Agent；
4. 抢占当前回合；

这些选项在官方公开资料中没有统一定义。

# Priority、queue、interrupt、resume

- Priority：未找到官方的前台输入与后台事件优先级表。
- Queue：未找到官方 durable user-message queue 或 inbox API。任何排队实现都应视为调用方设计。
- Interrupt：API 支持请求取消/连接关闭等传输层行为，但没有公开“用户新输入自动中断正在运行的 agent turn”的语义。
- Resume：上下文由客户端重新提交；DeepSeek API 本身不等同于一个持久化会话恢复器。

# Trace 与 queue 边界

公开 API 的消息历史是模型上下文，不是调度事实。一个 harness 可以把后台事件序列化成消息，但这属于二次投影；“尚未执行的 intent 排队顺序”不应伪装成已经发生的模型消息。由于 DeepSeek 没有公开 harness 规范，无法证实其产品是否遵循这一边界。

# 与 Iris 的对照

Iris 当前的严格串行 Intent mailbox 比公开可见的 DeepSeek API 更明确：

- 所有来源（用户、后台任务、其他 Agent、文件监听器）都是 Intent producer。
- 一个 Agent 只有一个 currentIntent；普通 Intent FIFO，不偷偷插队。
- pending queue 属于 Agent 层，不写入 Trace；只有消费后才产生 provider/tool 事实。
- 后台完成事件转成新的 Intent，不能在当前 provider turn 中“直接插播”。

这不是与 DeepSeek 官方实现的直接对比，而是对“模型 API 不负责调度”这一事实的工程化落实。

# 可吸收设计

- 保持模型供应商无关：不要把 DeepSeek API 的请求/响应层误当成队列层。
- 为每个外部事件定义来源、幂等键、时间戳和关联 task/intent ID，再由 Agent mailbox 统一排序。
- 将后台任务结果分成“通知型事件”和“需要模型处理的业务 Intent”，避免所有进度都进入上下文。
- 对供应商无持久化保证的场景，队列、恢复和崩溃重放必须由 Iris 自己负责。

# 不应照搬或臆测的设计

- 不应根据第三方 `DeepSeek harness` 项目推断 DeepSeek 官方优先级语义。
- 不应假设后台任务完成会自动抢占前台回合。
- 不应把一次 API 请求中的 messages 数组当作 Agent mailbox；它只表示提交给模型的上下文快照。

# 证据不足与后续验证

目前没有公开、可复现的 DeepSeek 官方 harness 行为可用于回答“前台新输入 vs 后台完成事件谁先执行”。若未来接入某个具体 DeepSeek 产品或第三方 harness，应针对同一 session 记录原始事件日志，验证：事件入队时间、消费顺序、是否中断当前 turn、恢复后是否重复投递，以及 Trace 是否只记录已消费事实。
