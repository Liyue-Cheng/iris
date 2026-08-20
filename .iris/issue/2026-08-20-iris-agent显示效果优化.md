---
title: iris agent显示效果优化
status: In Review
---
现在agent的显示效果我认为还是有些问题

25327 bytes E:\projects\iris · PowerShell 7 (pwsh.exe): exit 0, 857 bytes

这些不要显示

每一个信息获取，显示成功和失败，失败原因可以展开就行了

<br />

rg -n "new SettingsManager|JsonStore" src/main/settings-manager.test.ts | Select-Object -First 10; rg -n "settings-manager" vitest.config.ts package.json

E:\projects\iris · PowerShell 7 (pwsh.exe): exit 1, 229 bytes

\[?9001h\[?1004h\[?25l\[2J\[m\[H4:import type { JsonStore } from './persistence'; ]0;C:\Program Files\PowerShell\7\pwsh.exe\[?25h75:    } as unknown as JsonStore\<Settings>; 76:    const manager = new SettingsManager(store);   Command exited with code 1

<br />

命令失败的回显渲染不正确

<br />

命令出现非预期的失败\
npm test -- --reporter=dot src/main/agent/session-manager.test.ts 2>&1 | Select-Object -Last 30

\[?9001h\[?1004h\[?25l\[2J\[m\[H]0;C:\Program Files\PowerShell\7\pwsh.exe\[?25h]0;npm]0;npm test --reporter=dot src/main/agent/session-manager.test.ts]0;C:\WINDOWS\system32\cmd.exe ]0;node (vitest)]0;C:\Program Files\PowerShell\7\pwsh.exe\[?9001l\[?1004l Command exited with code -1073741510

<br />

```
npx tsc --noEmit -p tsconfig.node.json 2>&1 | Select-Object -Last 20; Write-Host "node-exit=$LASTEXITCODE"
```

Interactive terminal commands are not supported in this Iris Agent milestone.

对交互式命令的识别不正确

<br />

然后是现在时间很长的命令还是无法正确处理，你看看之前的产品决策，理解应该怎么做

## 问题理解

这些现象不是四个独立的前端问题，而是同一条终端执行链路没有建立稳定的事实模型：

1. 当前终端执行把 `PowerShell 7 (pwsh.exe): exit 0, 857 bytes` 拼成
   `resultSummary`，Renderer 只能把 shell、绝对 cwd、退出码和字节数一起展示。它们是诊断
   元数据，不应该占据默认时间线。
2. PTY 原始字节既被当作真实终端记录，又直接回传给 Pi 的 terminal tool。ConPTY 产生的
   ANSI/OSC 控制序列因此进入工具错误文本，再被普通文本组件原样渲染。
3. “PTY 成功启动并返回结果”和“命令以 0 退出”被混成一个成功状态。非零退出码目前仍将
   main 中的 Tool Activity 结算为 `completed`，随后 Pi 才把它包装成
   `Command exited with code N`。模型、canonical state 和界面看到的失败语义不一致。
4. `looksInteractive()` 对整条命令做关键词正则，参数中的 `tsconfig.node.json` 也会命中
   `node`。而且“是否需要交互”本来就不能可靠地从一段 shell 字符串静态推断。
5. 3 秒的产品展示阈值被同时用作强制执行超时；`timeout` 在 Pi 中按秒定义，main 又直接按
   毫秒使用并硬性截到 3000。于是正常测试、类型检查和 Vivado 都会被 Iris 主动发送
   Ctrl+C，Windows 下表现为 `0xC000013A`。
6. `AgentCommandPty` 虽然会产生 `shown` 和增量输出事件，但当前 Tool Host 没有把这些事件
   接入 Agent session 与 Renderer。因此即使去掉 3 秒 kill，也还没有真正实现既定的长终端
   标签、实时回放和用户接管。

所以不应分别做“隐藏几个字段”“正则多加边界”“strip ANSI”“把超时调大”四个补丁。这样只会
继续让执行事实、模型结果和 UI 状态互相矛盾。

## 统一治理目标

沿用此前已经确定的产品边界：

* 单个分支保持严格同步。长命令是当前尚未完成的前台工具调用，命令结束前 Agent 不继续依赖
  其结果的推理。

* 3 秒只是界面显现阈值，不是调度或超时阈值。超过 3 秒仍在运行时，自动显示同一个真实
  终端从启动开始的完整内容。

* 长命令每 20 秒检查一次新增输出；正常检查不进入历史，异常时才请求用户决定是否终止。

* 完整终端是第一事实，摘要只是投影。用户始终能检查真实命令、完整 scrollback、运行状态和
  退出原因。

* Agent 终端属于对应的 Iris Agent session，在 Agent 内部以标签页展示，不进入 issue 顶部的
  普通 terminal session 列表。

在工程上将其收敛为一句话：**一个 main-owned 的 Agent Terminal Run，派生三种用途明确的
投影，任何投影都不再反向充当事实源。**

```text
Agent Terminal Run（唯一事实）
  ├─ 原始 PTY 字节 + TerminalMirror -> 真实终端回放/用户输入
  ├─ 结构化 outcome                 -> activity、卡片状态、失败原因
  └─ 纯文本观察视图                  -> 模型结果、20 秒监督、错误摘要
```

## 一、统一终端事实模型

在 main 中为每次 terminal provider call 建立持久的 `AgentTerminalRun`，由 Agent session 持有。
它至少保存以下结构化字段，而不是继续依赖 `resultSummary` 文本：

* 身份与归属：`terminalId`、`sessionId`、`turnId`、`toolActivityId`；

* 启动事实：实际执行的 `command`、项目相对 `cwd`、shell、开始时间；

* 生命周期：`starting | running | exited`；

* 结果：`success | command-failed | launch-failed | canceled`；

* 退出事实：`exitCode`、`signal`、完成时间、是否由 Iris 发起终止；

* 展示事实：`revealedAt`、用户是否已主动切回 Agent；

* 输出事实：raw artifact、当前 cursor、纯文本观察 cursor，以及是否截断的显式信息。

Tool Activity 的 `running/completed/failed/canceled` 从这个结果确定性投影：默认退出码 0 是
`completed`，非零是 `failed`，用户停止是 `canceled`。但“宿主成功返回了一个非零退出结果”
仍是成功的 IPC 往返，不能用 `tool-result ok: false` 丢掉输出；worker 获得结构化 terminal
result 后再按同一 outcome 生成 provider tool result。这样 main、Pi 和 UI 对成功/失败只有一套
定义。

少数命令用非零退出码表达正常空结果，例如直接执行 `rg` 时退出码 1 表示无匹配。不能靠
分析输出文字猜测，应在 terminal 请求中显式声明允许的成功退出码，默认始终是 `[0]`；声明值
一并持久化。复合 shell 命令仍以整条命令的最终退出结果为准，不尝试用字符串拆分分号和管道。

## 二、原始终端与纯文本严格分流

原始 PTY 字节继续完整追加到不可变 artifact，并进入 Iris 已有的 headless xterm mirror。这份
数据只用于真实终端、scrollback、alternate screen 和重放，不能直接放进聊天 DOM 或错误
字符串。

在同一个 `TerminalMirror` 上增加受控的纯文本观察接口：解析 ANSI/CSI/OSC、光标移动、覆写和
alternate screen 后，从 terminal buffer 导出用户实际可读的文本。不要用正则 `stripAnsi`
代替终端解析器，因为 spinner、清屏、回车覆写和 TUI 都不是删除 escape 字节就能正确还原。

三类消费者分别读取：

* Renderer 终端标签读取原始 replay snapshot 和后续 PTY 增量；

* provider tool result 只接收有上限的纯文本尾部、退出事实和明确的截断标记，不再跨 IPC 回传
  整份 raw `outputBase64`；

* 失败详情与 20 秒监督读取 cursor 化的纯文本观察；alternate screen 下同时提供当前屏幕
  snapshot，避免把 TUI 的控制序列交给模型。

完整原始输出始终能从终端标签查看，纯文本截断不能造成“完整记录也丢了”的假象。

## 三、信息获取卡片统一为逐项结果

“本地获取”继续聚合连续的 read 和 `terminal(intent: information)`，但每一个 provider tool
call 是一个 item，并显示自己的确定状态：

```text
本地获取                         4 项 · 1 项失败
  settings-manager.test.ts                         成功
  rg -n "new SettingsManager|JsonStore" ...        成功
  rg -n "settings-manager" vitest.config.ts ...    失败  [展开]
  package.json                                      成功
```

默认行只保留“获取对象/实际命令 + 成功或失败”：

* 文件读取显示项目相对路径，不显示读取字节数；

* 信息终端显示实际命令，不显示项目根绝对路径、shell 名、可执行路径、输出字节数和成功退出码；

* 成功、失败必须有图标和文字，不能只靠颜色；运行中保留稳定尺寸的进度状态；

* 失败项才出现展开动作。展开后显示结构化原因，例如“命令退出码为 1”或“进程启动失败”，
  再显示清理后的短输出尾部；

* 完整输出通过“打开终端”查看，不在聚合卡里复制 scrollback；

* mixed outcome 的卡片是 `partial`，Header 显示总项数和失败数。

这里不解析一条复合 shell 命令中的多个子命令来制造虚假的逐子命令状态。需要独立结果的查询
应由 Agent 发成独立 terminal call；未来专用 search/grep 工具也可以天然提供更细粒度事实。

操作终端卡使用同一套 outcome 和失败详情，但仍按既定规则保持“一次 operation terminal call
一张独立卡”，并常驻展示实际命令。成功时不堆叠诊断元数据；失败时展示简短原因和打开真实
终端的入口。

## 四、交互命令不识别、不拦截

删除 `looksInteractive()` 以及任何替代它的交互命令分类、黑名单、正则或模型声明。terminal
tool 不需要 `interaction` 字段，运行时也不需要猜测一个 CLI 是否正在等待 stdin。所有命令都
无条件进入同一种可输入的真实 PTY；`tsconfig.node.json`、路径和参数中的 `node`、`python`、
`more` 不再具有任何特殊含义。PowerShell 启动参数也不能禁止用户向 PTY 输入。

交互命令与长命令统一服从 3 秒规则：

* 3 秒内进程自然退出，只在 Agent 历史中结算精简结果；

* 3 秒后仍未退出，无论原因是正常计算、等待输入、持续服务还是 TUI，都在当前 Agent 内建立并
  自动切换到正式 Terminal；

* Terminal 从命令启动的第一个字节完整重放，并直接连接同一个 PTY；

* 如果命令正在等待输入，用户此时直接输入即可，tool call 和主 Agent loop 继续同步等待；

* 用户输入只记录“发生过输入”和必要计数，不持久化明文键盘内容；

* 用户主动切回 Agent 后，终端不能再次抢焦点。

这里不追求“在 3 秒内提前识别交互”。交互命令显然不会在等待输入时自行结束，因此到达 3 秒
后自然进入正式终端。产品只需要保证同一个 PTY 可见、可输入和可终止，不需要额外分类体系。

## 五、长命令的完整生命周期

terminal tool、Pi adapter、Worker protocol 和 main Tool Host 中都不设置 `timeout`、
`timeoutMs` 或 `timeoutSeconds` 字段。所有命令都没有运行时长上限，main 不创建执行超时定时器，
也不存在按时长自动 kill 的状态。唯一的 3 秒定时器只产生 reveal 事件，不控制进程生命周期。

```text
t=0      创建 AgentTerminalRun，启动 PTY，开始保存全部输出
t<3s     若正常结束：只在历史中结算精简结果
t=3s     仍在运行：建立并首次自动切换 Terminal 标签，从 t=0 完整回放
t=20s    读取上次 cursor 后的纯文本增量；无新增则不调用模型
每 20s   临时监督调用判断是否正常，正常结果丢弃，不进入 session 历史
异常     保持进程运行，暂停正常监督，在 Agent 中说明证据并询问继续还是终止
结束     结算同一个 Tool Activity，工具结果回到当前因果链，终端标签保留可回看
```

用户主动从 Terminal 切回 Agent 后，同一终端的后续输出不能再次抢焦点。命令只会因自身退出、
用户明确中断/终止，或 session、工程、应用的明确生命周期收尾而结束；运行时长永远不是终止
原因。3 秒显现和 20 秒监督都不能自行 kill。终止应记录发起者与原因，区分命令自身失败和
Iris 主动中断，Windows 的 `0xC000013A` 也不再被误报成测试失败。

监督不是新 Agent turn，也不调用 `AgentSession.prompt()`。它直接使用 provider/model 层，输入
仅包含本次 terminal run 的少量状态和最新观察，完成即丢弃。发现异常后需要增加明确的
`waiting-user`/decision 状态；用户选择继续后从新 cursor 恢复监督，选择终止后才结束 PTY。

## 六、Agent 内部终端工作面

不要把 `AgentCommandPty` 继续做成一套只能写 log 的旁路 PTY。应复用 Iris 现有 terminal
runtime 的 PTY、TerminalMirror、replay、输入、resize 和进程收尾能力，在其上增加
`owner: { kind: 'iris-agent', sessionId, terminalId }`。这种 terminal 不进入右栏顶部 session
选择器，只投影到对应 `IrisAgentView` 的内部标签：

```text
[Agent] [npm test · 运行中] [vivado · 运行中]
```

第一次到达 3 秒阈值 reveal 时自动切换一次；完成后标签保留，用户可以关闭工作面，但关闭
视图不删除 terminal artifact 或时间线审计记录。短命令完成后不自动建标签，失败卡仍可按需
打开同一份只读终端记录。

## 七、实施顺序

这项治理应作为一条纵向链路落地，避免先改 UI 后继续依赖错误字符串：

1. 先调整 protocol/session schema，建立 `AgentTerminalRun`、结构化 outcome 与输出 artifact，
   并从 terminal tool、Pi adapter、Worker protocol 和 main Tool Host 中彻底移除 timeout 字段；
   旧 terminal activity 做保守迁移。
2. 再把 Agent terminal 接到共享 terminal runtime，贯通启动、raw persistence、mirror、输入、
   replay、resize、停止和 owner lifecycle；移除 3 秒 kill 与拒绝式交互正则。
3. 然后改 worker adapter：raw 与 plain-text 分流，限制模型输出体积，保证非零退出、启动失败和
   取消在 provider tool result 与 main canonical state 中一致。
4. 接入 3 秒 reveal、Agent 内部 Terminal 标签和打开完整输出动作。
5. 基于结构化 DTO 重做本地获取与操作终端卡，删除 `resultSummary` 在 Renderer API 中承担的
   展示协议职责。
6. 最后接入 20 秒临时监督与异常决策状态；它依赖前面的 cursor、纯文本观察和 terminal
   lifecycle，不能用命令行轮询先做一个旁路版本。

schema 迁移时，旧记录若只有 `resultSummary` 和 raw log，不反向解析这段字符串来伪造可靠字段。
旧卡标记为历史记录，能确定的 command、cwd、terminalId 原样保留，未知 outcome 保守展示为
“结果未知”；新记录只走结构化字段。

## 验收清单

* [x] 信息获取每一项都明确显示运行中、成功或失败；默认行不再显示字节数、项目根绝对路径、
  shell 名和成功退出码，失败原因可以逐项展开。

* [x] 非零退出码在 main、provider tool result 和 Renderer 中一致表现为失败，同时保留清理后的
  输出摘要和真实终端入口；混合成功/失败的本地获取卡显示部分失败。

* [x] ANSI、OSC、清屏、回车覆写与 alternate-screen 输出不会以 escape 文本进入卡片或模型；
  原始终端仍能完整、正确回放。

* [x] `npx tsc --noEmit -p tsconfig.node.json` 能实际启动，不会因为参数含 `node` 被拒绝。

* [x] terminal 链路不存在交互命令识别或 `interaction` 字段；直接交互/TUI 命令可以启动，超过
  3 秒后进入正式 Terminal 并由用户操作同一个 PTY。

* [x] 一个超过 3 秒的普通命令不会被终止，会在当前 Iris Agent 内创建 Terminal 标签并从 t=0
  完整回放；用户切回 Agent 后不再被抢焦点。

* [x] terminal tool、Pi adapter、Worker protocol 和 main Tool Host 均不存在 timeout 字段或
  执行超时定时器；测试、类型检查、Vivado 和交互命令都可以无限期运行。

* [x] 20 秒监督在无新增输出时不调用模型，正常判断不写入历史，异常判断等待用户决定且不会
  擅自终止进程。

* [x] 长命令完成后原工具调用才结算并继续当前分支；fork、切换 Agent 和关闭终端视图不会把
  正在运行的 terminal 所有权转移到别的 session。

* [x] 大输出不整份穿过 worker/Renderer IPC；模型和卡片得到带明确截断信息的纯文本视图，完整
  raw artifact 仍可从真实终端检查。

* [x] 增加 Windows ConPTY 集成覆盖和纯状态机单元测试，至少覆盖 3 秒 reveal、无限期运行、
  用户取消、非零退出、ANSI/OSC、交互输入、重启恢复和旧记录迁移。

## 实施结果（2026-08-20）

本次按统一终端事实模型完成了纵向改造：

* Agent Worker 协议升级到 v12；terminal tool、Pi adapter、Worker protocol、main Tool Host 与
  执行路径不再提供 timeout 字段，也不存在按运行时长终止进程的定时器。

* 删除 `looksInteractive()`、拒绝式全字符串黑名单和 PowerShell `-NonInteractive` 参数；所有
  命令进入同一种可输入 PTY，不再分类或猜测是否交互。

* main 持有 Agent terminal runtime。命令超过 3 秒只触发 reveal，同一个 PTY 在所属 Agent
  内建立 Terminal 标签，并支持从 t=0 回放、实时输出、输入、resize 和用户停止。主 Agent
  loop 在 terminal tool 完成前保持同步等待。

* 原始 PTY 数据只供 artifact、TerminalMirror 和真实终端使用；Worker、聊天 IPC、模型结果和
  卡片只接收 xterm buffer 导出的纯文本投影。UTF-8 跨 chunk 解码受控，模型输出最多 64 KiB，
  失败预览最多 8 KiB，并显式标记截断。

* terminal outcome 统一为 `success | command-failed | launch-failed | canceled`，并增加显式
  `successExitCodes`，默认 `[0]`。非零退出不会再被 main 记为成功，但结构化结果和真实终端
  仍完整保留给 Worker 与 Renderer。

* 本地获取卡逐项显示运行中、成功、失败；失败原因可展开，混合结果显示部分失败。短命令失败
  默认不创建工作面，用户可从失败项打开同一份终端记录；操作终端卡使用同一套 outcome。

* 每 20 秒监督纯文本增量；无新增输出不调用模型，正常和错误判断只安排下一次观察且不进入
  Agent 历史，可疑判断保持进程运行并等待用户选择继续观察或终止。监督调用独立于主 Agent
  turn，Worker 退出或崩溃时会结算悬挂请求。

* 重启恢复会把遗留的运行中 terminal activity 保守结算为 canceled，并清理监督提示。旧记录
  不解析 `resultSummary` 伪造结构化事实，只从已有 terminal effect 投影能够确定的信息。

## 验证记录（2026-08-20）

* `npm run typecheck`：通过。

* 定向测试：9 个测试文件、62 个测试通过。

* `npm test -- --poolOptions.threads.singleThread`：75 个测试文件、439 个测试通过。

* 已扫描 Agent terminal 链路，`looksInteractive`、旧交互拒绝文案、`outputBase64`、
  `-NonInteractive` 与 timeout 字段均无残留。

* 按项目约束未运行 build、dist、开发服务器或截图测试。Windows 上默认并发全量测试可能受到
  ConPTY/临时文件资源竞争影响，因此全量验证使用 single-thread pool，并正常返回退出码 0。

## 回归诊断（2026-08-20）

手工验证发现“点击用 Iris Agent 打开后约 5 秒才显示界面，随后模型不可用”。两个现象来自同一
条模型目录加载链路，与 terminal 的 3 秒 reveal 无关：

1. `openIrisAgent()` 在 Renderer 中等待 `IRIS_AGENT_OPEN` 完成后才选择并显示新 session；main
   的 `createSession()` 又同步等待 `loadModelCatalog()`。模型目录包含外部 `/models` 网络请求，
   因此供应商响应时间直接成为 Agent 面板的打开时间。
2. 当前开发环境配置了 Sudochat 和 PPAI Codex。现场只读探测中，Sudochat 在 447 ms 内返回
   HTTP 200 和 8 个模型；PPAI Codex 在 308 ms 内返回 HTTP 502。此前约 5 秒的等待不是产品内
   的固定定时器，而是该外部请求当时的响应耗时。
3. `createIrisModelRuntime()` 串行加载各供应商；任意一个 profile 的模型请求抛错都会中断整个
   runtime 创建。外层 `loadIrisModelCatalog()` 随后返回 `{ models: [], error }`，导致已经成功
   获取的 Sudochat 模型以及其他可用模型也全部丢失。
4. 新 session 因空 catalog 被持久化为 `model: null`。界面挂载后还会再次调用
   `listIrisAgentModels()`，重复一次运行时和网络初始化；Renderer 只把 catalog error 折叠成
   “模型不可用”，真实的 PPAI 502 仅放在不可见的 select title 中。

这暴露的是模型目录的启动耦合、失败隔离和错误呈现问题，不能通过延长等待时间处理。

* [x] 创建并显示 Agent session 不等待模型目录网络请求；先打开工作面，再异步填充模型状态。

* [x] 各供应商模型发现独立失败；一个 profile 不可用时保留其他供应商及内置可用模型。

* [x] 模型目录加载增加同进程 single-flight/cache，避免创建 session 与界面挂载重复初始化和请求。

* [x] 模型选择器显示具体失败供应商、错误原因和重试入口，不再只显示“模型不可用”。

* [x] 增加慢供应商、单供应商 5xx、部分成功和重复并发加载测试。

## 首条消息延迟回显诊断（2026-08-20）

首条消息点击发送后，Renderer 会立即清空输入框，但不会向本地 store 乐观插入用户消息。
`sendIrisAgentMessage()` 必须等待 `IRIS_AGENT_SEND` 的 main IPC 返回，或等待 main 的 session changed
广播，用户气泡才会出现。

main 当前又把用户 activity 的创建和第一次 `emitChanged()` 放在全部冷启动工作之后：

1. `assertUsableModel()` 重新加载完整模型目录并访问所有自定义供应商的 `/models`；
2. `preparePrompt()` 读取软件 prompt、项目 prompt 和当前 anchor，随后保存 assembled-input artifact；
3. `hostFor()` 创建 Worker host；其 `loadRuntime()` 为解析所选模型 base URL 再加载一次完整模型目录；
4. Worker 初始化中的 `createIrisPiSession()` 第三次创建 model runtime，并再次加载完整模型目录；
5. main 等 Worker 发出 `ready` 后，才把 user activity 加入 timeline、commit 并广播给 Renderer。

因此在两个自定义供应商的当前配置下，冷启动首条消息最多会触发三轮模型发现、六次
`/models` 请求。供应商网络耗时、单个 5xx、Worker 冷启动和 prompt artifact IO 都位于用户气泡
之前。后续消息若 Worker 仍在 60 秒存活期内会少一部分冷启动成本，所以首条最明显。

这里混淆了两个时刻：“客户端已经接受用户输入”和“Agent 执行环境已经准备好”。用户消息回显
不应等待模型发现、上下文组装或 Worker ready。

* [x] 发送动作立即以稳定 client message id 投影 pending 用户气泡，不等待 IPC 或 Worker 冷启动。

* [x] main 将“接受并持久化用户消息”与“准备并启动执行”拆成两个明确阶段；失败时把同一消息
  结算为可重试状态，而不是延迟出现或消失。

* [x] 发送前模型校验、base URL 解析和 Worker runtime 初始化共享同一份 catalog/runtime 结果，
  不再对全部供应商做三轮发现。

* [x] UI 明确显示消息已接受但 Agent 正在准备，区分本地提交、Worker 启动和模型首 token 等待。

* [x] 增加冷 Worker、热 Worker、慢模型目录、初始化失败和 pending 消息去重/回滚测试。

## 回归修复结果（2026-08-20）

本轮把 Agent 工作面打开、模型目录发现和首条消息提交拆成了相互独立的阶段：

* `createSession()` 不再加载模型目录或等待任何供应商网络请求。Renderer 先显示新 Session，再异步
  加载模型；目录尚未完成时选择器显示加载状态。无模型的新 Session 会选择首个健康模型；若机器
  记住的默认模型属于当前失败的供应商，也只在没有对话历史的新 Session 中回退到健康模型，已有
  对话不会被静默切换模型。

* 模型目录在 main 内按 generation 缓存并 single-flight。同一轮并发请求共享一个 Promise，普通
  重渲染读取缓存，只有供应商配置变化或用户点击重试才失效。多个自定义供应商的 `/models` 并行
  发现并各自隔离错误；PPAI Codex 一类 502 不再清空 Sudochat 等健康供应商的结果。

* 模型选择器保留健康模型，同时在可见警告区显示失败供应商和原始脱敏错误，并提供重试按钮。
  自定义模型的 Base URL 直接从对应 profile 解析；Worker 只注册当前已选 profile/model，保存 Key、
  删除凭据、解析 Base URL 和 Worker 启动都不再触发全供应商 `/models` 发现。

* `send()` 在 prompt 组装、artifact 写入和 Worker `ready` 之前，先生成稳定的 user activity/turn ID，
  提交 canonical Session 并广播 `starting` 投影。Renderer 因而立即看到用户气泡和“启动中”，后续
  准备失败会暂停同一个 turn，不会让消息延迟出现或消失。这里没有额外创建 Renderer 乐观副本，
  避免 client/server 两份消息的去重与回滚竞态。

## 回归修复验证（2026-08-20）

* `npm run typecheck`：通过，包含 node、preload、web TypeScript 与 async boundary 检查。

* 定向测试：`pi-adapter`、`session-manager`、`iris-agent-store` 共 3 个文件、37 项通过；覆盖打开
  Session 不触发发现、冷 Worker ready 前消息可见、目录 cache/single-flight/强制刷新、供应商并行
  发现、HTTP 502 部分失败保留健康模型，以及 Base URL 解析不访问网络。

* `npm test -- --poolOptions.threads.singleThread`：75 个测试文件、446 项全部通过。

* 按项目约束未运行 build、dist、开发服务器或截图测试。

- [ ] 在真实产品中确认“用 Iris Agent 打开”立即显示工作面，健康模型可选，失败供应商错误可见。

- [ ] 在冷 Worker 的真实 provider 会话中确认首条用户消息立即显示，并在随后正常进入模型响应。

<br />

<br />

然后我要求第二轮优化

首先是所有的分支按钮，都要附着在面模型回复和发送的卡片上，而不是空白处

然后是终端，明明iris有终端，你就不要整乱七八糟的了
