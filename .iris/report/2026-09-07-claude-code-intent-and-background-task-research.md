---
title: Claude Code 的 Intent 与后台任务行为调研
status: Active
---

# 调研范围与版本

本机 Claude Code 版本为 2.1.170（Windows native build）。证据来自 `claude --help`、`claude agents --help` 以及本机随 CLI 分发的 `~/.claude/cache/changelog.md`。报告关注交互式会话、`claude agents` 后台 Agent、后台 shell/Bash 和恢复行为；不把 Claude API 本身当成调度器。

# 可证实来源

本机证据文件：`C:\Users\liyue\.claude\cache\changelog.md`；官方产品文档入口：<https://docs.anthropic.com/>（本报告未将未能直接抓取的网页内容当作实现证据）。

CLI 帮助确认：

- `claude agents` 管理后台 sessions，可 `--json` 查看状态，`--all` 包括已完成会话，并显示 `id`、`state`、`waitingFor` 等字段。
- `--continue`/`--resume` 恢复会话；`--fork-session` 可从恢复点创建新 session。
- 交互界面支持 Esc 中断；`--print --input-format stream-json` 支持实时输入流。

2.1.170 changelog 及相邻版本明确记录：后台 sessions 跨 retire→wake 保留启动 flags；后台 agent 可在 `claude agents` 中并发管理；回复发送失败会排队到下次 session start；重连/重新附着不能丢失权限提示、会话历史或运行中的后台任务；后台 shell 在 `-p` 结果后约 5 秒停止以避免进程悬挂；后台 session 停止时向 shell 子进程发送 SIGTERM 后再 SIGKILL。

# 输入与后台事件时序

Claude Code 的产品结构是“一个 session + 可派发的后台 sessions/agents”，而不是把所有后台工作塞进当前模型 turn：

```text
主 session 当前 turn
        │
        ├─ 用户继续输入 / Esc interrupt
        └─ claude agents 派发独立后台 session
                         │
                         ├─ running / blocked / waitingFor
                         ├─ attach / reply / stop
                         └─ completed result
```

后台 agent 有自己的 session、工作目录/ worktree、状态和 transcript。用户在 agents 视图中可以附加、回复或停止它；后台结果首先更新后台 session 状态，而不是自动插入主 session 的当前 provider turn。

# Priority、queue、interrupt、resume

- Priority：`claude agents` 提供状态分组和并发 session 列表，最近版本还显示 `done/total`、最长运行 item 和 `waitingFor`。这是显式观察/选择机制，没有公开“后台完成抢占主输入”的规则。
- Queue：agents view 发送失败的回复会排队到下次 session start；这证明至少存在可靠投递队列。普通主 session 输入仍由当前交互 turn 消费，未见公开 FIFO/合并算法。
- Interrupt：Esc 在主 turn 中断；2.1.162 修复了 turn 刚开始时 Esc 被丢失的问题。后台 session 可 Stop，停止会清理 shell 子进程。中断和停止是控制路径，不应与普通业务消息混为一谈。
- Resume/reconnect：`--resume`、agents attach、daemon retire→wake 和更新后的重新附着都保留 transcript、flags、权限等待状态和后台任务；修复项特别防止“重新运行原 prompt”“丢失会话”“后台任务消失”。
- Background shell：Bash/background command 有独立进程生命周期；`-p` 模式在最终结果后会停止泄漏的后台 shell。后台 shell 输出还曾导致 stdout 污染，随后被修复为隔离输出。

# Trace 与 queue 边界

Claude Code 的 session transcript、后台 agent session、shell process 和 agents 列表状态是不同对象：

- transcript/session history 是已经发生的模型对话事实；
- agents list 的 running/blocked/completed/waitingFor 是外部 session 状态；
- 发送失败待投递的 reply 是队列项；
- shell 子进程输出是工具/进程结果，不能因为“后台完成”就伪装成主 session 的用户消息。

这支持 Iris 的边界：后台 task 完成应转换成新的 Intent，由 Agent mailbox 决定何时消费；Trace 不记录尚未消费的排队事件。

# 与 Iris 的对照

Claude Code 更偏向“后台任务是独立 session/agent”，Iris 选择“后台基础设施可并行，但所有结果回到同一个 Agent 的严格串行 Intent 流”。两者共同点是：状态持久化、显式 attach/stop、失败投递重试、重连恢复、后台输出隔离和进程树清理。

Claude 的 agents 视图允许用户主动选择哪个后台 session 进入前台，这相当于显式的控制 Intent，而不是隐式抢占。Iris 可以保留这一思想，同时坚持普通 Intent FIFO。

# 可吸收设计

- 为后台 task 建立独立生命周期和 task ID，状态至少包括 running、blocked/awaiting-input、completed、failed、canceled。
- 将 attach、reply、stop、resume 作为控制命令；控制命令可走独立高优先级通道，普通业务 Intent 仍 FIFO。
- 失败投递的用户/Agent消息持久化，下一次 session 启动或恢复时重试，并用幂等键防重复。
- 重连、daemon 重启、版本更新后恢复 session、权限等待和后台进程状态；禁止恢复逻辑重跑原 prompt。
- 后台 shell 的输出与主 transcript 分离；任务终态事件必须可靠投递，不能被进度事件合并掉。
- 停止任务时先清理进程树，再结束 PTY/会话，设置有限的 SIGTERM→SIGKILL 窗口。

# 不应照搬的设计

- 不要复制 Claude 的多 session agents UI 作为普通 Intent 调度规则；Iris 的核心约束是单 Agent 严格串行消费。
- 不要让后台 agent 直接写入主 Trace 或共享 checkout；需要显式 worktree/ownership 和结果 Intent。
- 不要把 `-p` 模式后台 shell 的清理时限当作通用业务 timeout；短命命令 timeout 与长任务后台化是两件事。

# 证据边界

本报告没有逆向 Claude Code 私有实现，也没有把本机历史记录当作官方协议。changelog 证明了很多可靠性修复和状态对象，但没有公开普通主输入与后台完成事件的完整排序算法。因此 Iris 仍应采用可解释的 mailbox 规则，而不是猜测 Claude 的内部优先级。
