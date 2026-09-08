---
title: Agent terminal 超时与后台任务设计调研
status: Active
---

# Agent terminal 超时与后台任务设计调研

日期：2026-09-07

## 调研范围

本报告比较了：

* Pi 0.84.1 的 `bash` 工具实现。
* Iris 当前 Agent terminal 的 schema、PTY、进程树清理、输出日志、session 状态机和 supervision。
* 当前 Codex CLI 0.146.1 的本地会话、`exec resume`、Codex Cloud 任务命令，以及官方 Codex 更新记录中关于后台任务和恢复能力的描述。

官方资料入口：

* [Codex CLI 命令帮助](https://developers.openai.com/codex/)
* [Codex 更新记录](https://learn.chatgpt.com/docs/changelog)

官方文档站点在当前网络环境返回 403；因此 Codex 的具体行为以本机 `codex-cli 0.146.1` 的命令帮助和官方更新记录索引为准，没有把无法直接打开的搜索摘要当成完整规范。

## 结论先行

应该给 Iris terminal 增加可选 `timeout`，但只把它当成模型可主动声明的“本次命令截止时间”，不能设默认超时，也不能靠命令字符串猜测长短任务。

推荐采用两阶段设计：

1. 先实现 Pi 风格的可选 timeout，限定为短时、可判定完成的命令；未填写时保持当前长任务行为。
2. 后续再把长任务从“阻塞当前 tool call”升级为独立的持久化 Agent Task。任务需要自己的 ID、状态、日志游标、取消和恢复接口，不能用 timeout 模拟后台任务。

这样可以满足用户提出的分类：格式化、查询、快速检查等基本命令可以填 timeout；打包、仿真、下载、服务器、长测试等任务不填 timeout，并由任务层负责观察和回收。

## Pi 的 timeout 语义

Pi 0.84.1 的 `bash` schema 是：

```json
{
  "command": "...",
  "timeout": 30
}
```

关键行为：

* `timeout` 是可选秒数，默认没有 timeout。
* 非有限数、零、负数会拒绝；上限为 Node.js 定时器允许的约 24.8 天。
* 超时时杀整个子进程树，而不是只杀 shell 根进程。
* abort 和 timeout 都等待进程真正结束后再结算工具调用，避免子进程仍占用句柄或继续写输出。
* 输出在内存中有上限；超限时保留尾部预览，并把完整输出写入临时文件，结果明确告知模型发生了截断以及完整输出位置。
* 超时错误会把已收集的输出和“Command timed out after N seconds”一起返回。

这里最值得吸收的是“无默认 timeout”和“进程树清理后再结算”，不是把 Pi 的 bash 进程模型直接替换到 Iris。

## Iris 当前能力与缺口

Iris 当前 terminal 已具备：

* PTY/ConPTY 执行和可见 terminal 展示。
* `information` / `operation` 业务 intent。
* 自定义成功退出码。
* 完整输出落盘、尾部预览、输出字节数和截断标记。
* Stop、关闭 session、项目切换时的 abort。
* Windows 进程树清理，且已保证先清理派生进程再关闭 PTY。
* 基于终端输出的周期性 supervision。

仍存在的 timeout/后台边界：

* 当前 schema 没有 timeout，所有命令都只能等待自然退出或用户 Stop。
* 一个 terminal tool call 会一直占用 provider turn；命令运行期间 session 状态是 `waiting-tool`，并不是已返回的后台任务。
* timeout 若只在 PTY 外层加定时器，必须把 timeout 触发、进程树清理、PTY 退出、日志 flush、tool result 结算串成一个终态，否则会出现“工具已经返回但进程仍在写日志”的竞态。
* Agent session 的持久化记录保存了 terminal activity 和日志路径，但应用重启后不能凭该记录重新连接一个仍在运行的本地进程。
* supervision 目前只能观察仍挂在当前 session 的 live terminal，不能观察脱离 provider turn 的独立任务。

## timeout 应该如何设计

### Schema

建议增加：

```ts
timeout?: number // seconds
```

约束直接采用 Pi：有限正数，转换为毫秒时限制在 `2_147_483_647` 以内。不要添加 `timeout: 0` 表示特殊模式，也不要让缺省值隐式变成几分钟。

### Prompt 规则

Prompt 应给模型清晰的正反例，而不是要求它分析所有命令：

适合填写 timeout：

* `git status`、`git diff --check`、文件检查、版本查询。
* 快速 lint、单个小范围测试、短脚本和明确有上界的查询。
* 预期几秒到一两分钟内结束的命令。

不填写 timeout：

* `npm run build`、打包、安装依赖。
* 仿真、编译大型工程、完整测试套件、数据处理和下载。
* 启动开发服务器、watch、交互式命令或可能等待用户输入的命令。

这不是安全边界。Tool Host 仍应校验 timeout 数值；但不应通过黑名单猜测“build/sim”并强制覆盖模型选择，因为项目命令名称和实际耗时高度不稳定。

### 结果与错误

timeout 触发后，返回给模型的错误应至少包含：

```text
Command timed out after 30 seconds.
The process tree was terminated. Partial output is included below; full output is available at <log path>.
```

结果要保持现有 Iris terminal result 结构，新增的只是明确原因和可恢复信息，不改变 `successExitCodes`、intent 或 terminal activity 的含义。timeout 应记为独立的 `terminalOutcome: timed-out`，不要伪装成普通 `command-failed` 或 `canceled`。

### 生命周期顺序

建议固定为：

```text
timeout fires
  -> mark timeout requested (idempotent)
  -> kill process tree
  -> close PTY
  -> wait for PTY exit
  -> flush output log
  -> settle tool result
  -> persist terminal outcome
```

任何一步失败都必须仍然有唯一终态；不能让超时定时器直接 reject provider promise 后把 PTY 留在后台。

## 为什么不能只靠 timeout 实现后台任务

Codex 当前命令面同时暴露了：

* `codex exec resume`：恢复已有本地会话。
* `codex cloud exec/status/list/apply/diff`：提交、查询和取回独立的云任务。
* 更新记录还显示了 durable user-message queue、interrupted turn recovery、running task exit choices、异步 command hooks、断线后保持 response stream 等能力。

这些能力共同说明，成熟后台任务的核心不是“等待更久”，而是：

* 任务有独立身份和状态机。
* 前台会话与任务结果可以暂时断开。
* 进程/执行器断线后可以重新连接或查询最终状态。
* 输出和事件有持久化来源，UI 重连不会丢失完成通知。
* 取消、重试、继续、应用结果等动作有明确的幂等边界。

Iris 当前的 `waiting-tool` 设计适合短命令，也能让用户离开界面后继续等待一个仍在运行的命令；但它还不是 Codex Cloud 或 Codex app-server 那种独立后台任务。对长任务直接加很大的 timeout，既不能解决应用重启恢复，也不能解决 provider turn 长时间占用、重复结算和任务查询问题。

## 推荐的后续阶段

### 阶段一：小范围 timeout

* 在 terminal schema、shared protocol、worker、Tool Host 和 prompt 中增加可选 timeout。
* 只对显式提供且通过数值校验的 timeout 启用硬截止；缺省不超时。
* 在 `AgentCommandPty` 内实现 timeout 状态和一次性清理，复用现有进程树 killer。
* 增加 `timed-out` terminal outcome、错误文本和测试。
* 保持 terminal 仍是同步 tool call；不宣称后台任务。

### 阶段二：独立 Agent Task

为长任务新增独立层，至少需要：

* `taskId`、session/intent/toolCall 关联和命令快照。
* `queued/running/succeeded/failed/timed-out/canceled/lost` 状态机。
* 持久化日志路径、字节游标、退出码和最后一次事件。
* `task.status`、`task.output`、`task.cancel` 或等价的宿主接口。
* 应用重启后的 `lost` 判定和日志保留策略；不能假设本地 PID 永远可重连。
* tool call 返回“任务已启动”后，provider 可以继续工作；需要配套 prompt 让模型按需查询状态，而不是盲目轮询。
* 任务完成通知必须幂等，并能在 UI/worker 重连后补发。

### 阶段三：长任务体验

* 对打包、仿真、完整测试等命令提供明确的后台启动提示和任务 ID。
* UI 显示运行中、最近输出、完成/失败/取消和日志入口。
* 允许用户在不结束 Agent session 的情况下停止或重新查看任务。
* 长任务不设置硬 timeout；可另设项目级最大运行时长，但那是任务策略，不是 terminal tool 的默认参数。

## 暂不建议

* 不建议给所有 terminal 调用设置默认 30 秒或 5 分钟。
* 不建议按命令字符串硬编码 build/sim 黑名单来强制 timeout 或强制后台化。
* 不建议让 timeout 到期后只调用 `pty.kill()` 而不等待进程树和日志结算。
* 不建议把“用户离开窗口”解释为后台任务完成条件；当前 session 已支持离开后继续运行，真正缺的是独立任务身份和重连语义。

## 验证依据

当前 Iris 代码核查位置：

* `src/main/agent/pi-adapter.ts`：terminal schema 与 provider tool 定义。
* `src/main/agent-worker.ts`：tool call 到 host operation 的转换和等待。
* `src/main/agent/tool-host.ts`：PTY 启动、结果回传和输出截断。
* `src/main/agent/command-pty.ts`：PTY、日志 flush、abort 和退出结算。
* `src/main/agent/session-manager.ts`：session 状态、terminal supervision、Stop/关闭和持久化。

Pi 0.84.1 参考实现：

* `dist/core/tools/bash.js`：可选 timeout、进程树清理、abort/timeout 错误和输出累加器。
* `dist/core/tools/output-accumulator.js`：有界尾部预览、完整输出文件和截断 details。

本报告只做调研和设计建议，没有修改 terminal timeout schema，也没有启动后台任务实现。
