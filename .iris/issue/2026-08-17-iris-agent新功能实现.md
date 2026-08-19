---
title: iris agent新功能实现
status: In Review
---
1：powershell工具

现在的终端工具好像是bash，这是不够的，windows上需要默认支持powershell

2：分支工具 你需要去网上阅读sillytavern的源代码，然后理解分支功能的语义，我们只分支对话，不分支其他状态

3：provider model 可以调整、保存

## 功能理解（2026-08-17）

这三个功能分别解决执行环境、会话派生和模型身份三个问题。它们不只是界面入口；如果底层状态没有明确归属，Worker 重建或应用重启后就会出现“界面看起来选中了，但实际执行语义已经变了”的问题。

### 1. Windows 默认使用 PowerShell 工具语义

我的理解不是把现有工具名称从 `bash` 改成 `powershell` 就结束，而是让 Agent 在 Windows 上从工具描述到实际执行都明确使用 PowerShell 方言：

- Windows 优先使用 `pwsh.exe`，不可用时回退到 `powershell.exe`；非 Windows 平台仍按对应系统 shell 执行。
- 提供给模型的工具名称、说明、提示词和示例都必须说明当前 shell 是 PowerShell，不能继续暗示 Bash，也不能推荐 `sed`、POSIX 管道或 Bash 引号规则。
- 命令仍由 Iris 的真实 PTY 执行，并保留现有的可见终端、完整输出、退出码、超时和中止语义；“支持 PowerShell”不应退化成在隐藏子进程里执行字符串。
- shell 的解析结果应是一次运行的明确事实。工具卡片和诊断信息应能说明实际用了 `pwsh.exe` 还是 `powershell.exe`，避免模型与用户看到不同的执行环境。

当前代码的命令 PTY 实际已经在 Windows 上调用 PowerShell，但 Pi 适配仍从 `createBashToolDefinition` 派生工具，Iris 基础提示词也仍有 `ls`、`find`、`cat`、`sed` 等偏 POSIX 的表述。因此现状是“执行层大体是 PowerShell，模型契约还不是完整的 PowerShell”，这正是该功能需要补齐的边界。

### 2. 分支只派生对话，不复制世界状态

我对照了 SillyTavern `release` 分支提交 `8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8` 的实现：[`getBranchChatSnapshot`](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/scripts/bookmarks.js#L166-L182) 对当前聊天执行 `structuredClone(chat.slice(0, mesId + 1))`，即复制包含所选消息在内的历史前缀；[`createBranch`](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/scripts/bookmarks.js#L186-L243) 将它保存为新的独立聊天并记录来源；[`branchChat`](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/scripts/bookmarks.js#L449-L468) 创建后直接切换到新聊天。原聊天不被截断，两个聊天之后独立发展。

Iris 应采用这套核心语义，但分支对象是 `IrisAgentSession`：

- 用户从一个已经完成的历史节点创建新 Session；新 Session 继承截止该节点的对话前缀，原 Session 保持不变，并自动切换到新 Session。
- 新 Session 继承原 anchor、当前 provider/model 配置，以及能够重建有效模型上下文所必需的 canonical message。这里包括成对完整的 tool call/result provider 消息，否则历史对模型而言会失效；它们是对话因果链，不代表再次执行工具。
- 新 Session 保存 `parentSessionId` 和明确的 fork 节点，供来源追踪和命名使用。默认 UI 只需把它作为另一个 Session 放进现有选择条，不必先实现大型对话树。
- 不复制 Worker 运行状态、PTY/进程、终端标签、未完成工具调用、tool event 运行记录、文件 mutation ledger、Undo receipt、请求 artifact，也不复制文件系统、Git、网络等外部副作用。
- 两个 Session 继续共享同一个真实项目目录。因此分支是“对话视角的派生”，不是工作区快照；分支前已经发生的文件改动仍然真实存在，后续任何一边的改动也会被另一边从磁盘看到。
- 第一版只允许在静止 Session 的完整历史边界上分支，不能从正在流式输出或工具调用尚未闭合的位置分支。

它与现有 Rewind/Retry 不同：Rewind 删除本 Session 最后一轮对话，Retry 替换失败或停止的末轮，而 Fork 保留原 Session 并创建一条新的继续路径。SillyTavern 的 swipe/checkpoint、角色和群聊元数据不属于 Iris 本功能。

### 3. Provider/model 是可持久化的 Session 配置

这里的“可以调整、保存”首先应解释为：用户选择的是一个原子的 `{ provider, modelId }`，它属于 Iris Agent Session 的 canonical state，而不是只存在于下拉框或当前 Worker 内存里。

- UI 展示当前 provider 和 model，并只列出 `ModelRuntime` 能解析的模型；认证不可用、模型已移除或配置损坏时给出明确状态，不静默换成另一个模型。
- 只允许在 Session 没有运行中的 turn 时切换。切换影响下一次 provider 请求，不重写旧消息，也不假装旧历史由新模型生成。
- 选择结果写入 main-owned Session store。Worker 空闲回收、Worker 崩溃重建、renderer reload 和应用重启后都必须恢复同一选择。
- Fork 继承源 Session 在分支时的 provider/model，但创建后可以独立修改。
- 每次实际请求和 context artifact 继续记录真正使用的 provider/model，用来验证“保存的配置”和“实际调用”一致。

当前实现虽然创建了 Pi `ModelRuntime` 并读取 `auth.json`、`models.json`，但 `IrisAgentSessionInfo` 没有 model 配置，Worker 初始化也没有把显式 model 传给 `createAgentSession`。Pi 因而只能从设置或可用 provider 默认值中选模型，Worker 重建后无法由 Iris Session 自己保证选择稳定。

“保存”建议分成两层，不混为一个隐式全局状态：Session 选择必须保存；如果希望新建 Session 自动沿用上次选择，再单独保存一个用户级的新 Session 默认值。修改某个已有 Session 不应顺带改变其他已有 Session。

### 三者之间的关系

PowerShell 决定工具命令如何被模型理解和执行；provider/model 决定由谁产生下一步行为；Fork 则复制截止某个时点的对话认知，并继承当时的模型配置。共同原则是：对模型可见的契约、main 持久化的 canonical state 和真实运行时必须一致，不能依赖 renderer 临时状态或 Pi 的隐式默认值。

## 关于完成后三项后开始自举的判断

我赞成完成这三项后接入 OpenAI 模型，开始受控的自举试跑。这里应区分两个里程碑：

- **开始尝试自举**：Iris Agent 可以在人工监督下修改 Iris 自身，运行短测试，把方案和结果写回 Issue；失败后能停止、Fork 或回到另一条对话路径。
- **正式具备自举资格**：上述过程经过多轮真实 Issue 验证，并覆盖 Worker 重建、应用重启、provider 故障、长命令和恢复路径，才能去掉当前 `selfHostingEligible: false` 的产品限制。

这三个功能刚好补齐试跑前最关键的三个缺口：

1. PowerShell 让模型对 Windows 上的真实执行环境形成正确认知，否则自举时生成错误 shell 命令的概率太高。
2. Fork 让同一 Issue 可以从可靠历史节点尝试另一种实现，而不破坏原对话，也不伪造工作区副本。
3. provider/model 持久化让一次自举任务始终知道自己在使用哪个模型，Worker 重建后不会静默换模型。

现有实现已经具备一部分重要基础：最新 Issue/项目指令的发送前组装、main-owned 文件与终端工具、真实 provider context artifact、Stop、Retry、Rewind、Worker 隔离和 Session 持久化。因此完成三项后，不需要先建设一个更大的 Agent 平台才开始验证。

但“接入 OpenAI”仍有一个独立的启用步骤：Pi `ModelRuntime` 已经提供 OpenAI provider、模型目录和认证能力，Iris 需要把凭据可用性、模型选择和实际请求身份接通并展示出来。内部试跑可以先使用受控的本机凭据；产品化的登录、登出和凭据管理可以晚于第一轮自举验证，但不能把密钥写进项目或 Session 文件。

### 首轮自举试跑门槛

- [ ] Windows 工具契约和实际 PTY 都明确使用同一个 PowerShell，并通过真实短命令验证退出码、错误输出和中止。
- [ ] OpenAI provider/model 能被选择并保存；Worker 回收和应用重启后仍恢复同一选择，实际 context artifact 记录的身份一致。
- [ ] Fork 能从完整 turn 创建新 Session；原 Session 不变，新 Session 不继承终端、运行状态或 mutation ledger。
- [ ] OpenAI 模型能完成一次只读代码调查，并把结论写回当前 Issue。
- [ ] OpenAI 模型能完成一次小范围 Iris 源码修改和定向测试，人工检查 diff、测试结果及 Issue 写回均正确。
- [ ] 在上述真实任务通过后，再把自举资格从硬编码的 `false` 改为明确的实验开关；首轮不直接宣称正式可自举。

建议首个自举任务刻意选择低风险、边界清楚、测试快速的改动。不要把“实现这三个功能本身”作为第一次自举任务，因为那会让尚未验证的能力同时修改自己的关键运行时，出现问题时难以区分是模型、provider、Session、工具还是分支语义导致的。

## 实现记录（2026-08-17）

本轮开始实现三个功能，范围固定如下：

- [x] Windows Agent 工具向模型明确声明 PowerShell，并与实际 `pwsh.exe` / `powershell.exe` 选择保持一致。
- [x] 从完整 turn 分支出独立 Session，只继承对话前缀、anchor、lineage 和 provider/model 配置。
- [x] 枚举可用 provider/model，允许空闲 Session 切换并持久化，Worker 重建后使用同一模型。

OpenAI 凭据的完整登录/登出产品界面和正式解除自举限制不属于本轮；本轮提供模型运行时所需的可用性与选择闭环，为下一步受控接入准备基础。

## Provider 配置补充与实现结果（2026-08-18）

用户进一步明确：单个 provider 对应一个全局 Key 的设计不成立，因为同一供应商可能有多个 Key，OpenAI/Anthropic 兼容接口也需要各自的 Base URL。最终实现改为“供应商模板 + 已配置方案”模型：

- 设置页新增 `Iris Agent` 分类。用户先选择 OpenAI、Anthropic、OpenAI Compatible 或 Anthropic Compatible 模板，再填写方案名称、Base URL 和 API Key 后添加。
- 官方模板预填默认 Base URL；兼容模板要求填写有效的 HTTP(S) Base URL。同一模板可以添加多个方案，每个方案有独立 ID、名称、Base URL 和 Key。
- 已配置方案列表显示方案名称、模板、实际 Base URL 和掩码 Key，并允许逐项删除。完整 Key 不通过 provider catalog 或 model catalog 返回 renderer，也不进入项目和 Session 文件。
- 每个方案在 Pi `ModelRuntime` 中注册为独立 runtime provider。Agent 顶栏按“方案名称/模型”显示并保存精确 `{ provider, modelId }`；删除正在被 Session 引用的方案后，该选择明确显示为不可用，不会静默切换。
- 添加或删除方案前会检查所有窗口中的 Iris Agent Session；存在运行中的 Session 时拒绝修改。修改成功后回收旧 Worker 并广播 catalog 更新，下一次启动使用最新方案。
- Worker 加载同一份用户级方案配置，并把所有 profile Key 纳入 provider context artifact 的已知 secret 脱敏集合。

三项功能的其余实现结果：

- Windows 命令 PTY 与 Worker 共享同一个 shell identity，优先 `pwsh.exe`、回退 `powershell.exe`；工具说明、基础提示词和示例都使用 PowerShell 语义。
- 完整 settled turn 可创建独立 Session。新 Session 只继承对话前缀、anchor、lineage 和当时的 model；不继承 Worker、PTY、tool event、file effect、request fact、Undo receipt 或 artifact 状态，原 Session 保持不变。
- Session store 与 Worker protocol 升级到 v4；旧 v1/v2/v3 Session 可迁移，model 选择经过 CAS 校验、持久化，并在 Worker ready 时核对实际身份。

验证结果：

- `npm run typecheck` 通过，包含 main、preload、renderer 和 async boundary 检查。
- Agent 定向回归 5 个文件、46 项通过；provider profile 覆盖同一模板的两个方案、独立 runtime provider、Base URL 持久化、删除，以及 catalog 不泄露 Key。
- 完整 Vitest 共 74 个文件、433 项：432 项首轮通过，唯一失败是 Windows 临时目录原子 `rename` 偶发 `EPERM`；失败文件单独重跑 17/17 通过。
- 按项目约束未运行 build、dist、开发服务器或截图。

- [ ] 在设置页分别添加一个官方 OpenAI 方案和一个 OpenAI Compatible 方案，确认列表、删除和多 Key 操作符合预期。
- [ ] 在 Agent 顶栏选择具体方案/model，完成一次真实请求，并验证 Worker 空闲回收与应用重启后仍恢复同一选择。
- [ ] 从一个包含工具调用的完整 turn 创建分支，确认原 Session 不变且新 Session 不出现旧终端、工具事件或 Undo 状态。

## Worker Electron 导入修复（2026-08-18）

实际运行曾报错：`The requested module 'electron' does not provide an export named 'app'`。根因不是 provider API，而是 profile 存储复用了 `JsonStore`，依赖链为 `provider-profiles -> persistence -> logger -> electron.app`；这使 Agent Worker 的 ESM bundle 间接导入了只应由 main 使用的 `electron.app`。

修复后 profile 存储只依赖 Node 文件 API 与 `writeFileAtomic`，保留主文件、`.bak` 恢复和同目录原子替换，不再依赖 `JsonStore`、logger、settings manager 或 Electron。profile root 仍由 main 解析并通过 Worker 初始化协议显式传入，Worker 不自行判断 dev/installed 路径。

- [x] 确认 Agent Worker 的源码依赖链不再包含 logger、persistence、settings manager、build type 或 Electron。
- [x] `npm run typecheck` 通过；protocol、Session manager、Worker host 和 Pi adapter 共 43 项定向测试通过。
- [ ] 重启当前 Iris 开发进程，使 electron-vite 重新生成 Agent Worker bundle，并确认设置页添加方案后可正常启动 Session。

## 兼容供应商连通性诊断（2026-08-18）

使用各方案已保存的 Key 对其 `GET /models` 端点进行了只读实测，未输出或写回完整 Key：

- `Sudochat` 的 `https://api.sudocode.chat/v1/models` 返回 `200`，共 9 个模型，包含 `gpt-5.6-sol`。
- `PPAI Codex` 的 `https://new.pumpkinai.vip/v1/models` 返回 `200`，共 6 个模型，包含 `gpt-5.6-sol`。

因此这两个案例的 Base URL、Bearer 鉴权和模型目录均可用，当前失败不能归因于使用了 Chat Completions；Iris 对两者注册的协议都是 `openai-responses`。`503 shell_api_error` 是供应商网关返回的非标准上游错误，说明请求已经到达供应商，但其模型路由或后端执行失败。

进一步核对后修正了对 `Request timed out.` 的解释：Iris 通过 Pi `createAgentSession` 显式传入 HTTP idle timeout，默认是 300 秒；本机 `C:\Users\liyue\.pi\agent\settings.json` 也没有 `httpIdleTimeoutMs` 或 `retry.provider.timeoutMs` 覆盖。因此约 5 秒出现该文本不是 Iris 的应用级请求期限。OpenAI JS SDK 6.26.0 会把底层 fetch 错误及其 cause 中任何包含 `timeout` / `timed out` 的连接失败统一格式化为 `APIConnectionTimeoutError: Request timed out.`，原始 TCP、TLS、DNS 或 Undici cause 随之没有展示在当前 Agent UI 中。

对 Sudochat 进行了差分 Responses 实测：

- Codex 0.146.1 形态、含 Codex 请求头：`200`，约 1.46 秒，收到 `response.completed`。
- 同一 payload 去掉 Codex 请求头：`200`，约 4.22 秒。
- 再加入 Iris 使用的 `max_output_tokens: 128000`：`200`，约 1.25 秒。
- 原样重放此前失败时落盘的 Iris 完整 payload（约 18 KB 输入、4 个工具、reasoning medium）：`200`，约 26.76 秒。
- 完整 Iris payload 加 Pi 的 `session_id` / `x-client-request-id` 请求头：`200`，约 27.21 秒。

PPAI 对同一请求执行 Retry 后也曾在约 25.34 秒完成。以上结果排除了确定性的 Responses 协议、Codex 客户端白名单、模型目录、工具 schema、128k 输出字段和 Pi session header 不兼容；当前证据指向间歇性的供应商上游 503 与 Node/Undici 连接层失败两类问题。由于现有错误格式化丢失了底层 cause，还不能从 UI 文本区分 DNS、TCP、TLS 或连接建立超时。

- [ ] 分别对两个方案执行最小化 `POST /responses` 探测，记录响应状态、首事件延迟和脱敏后的错误体，区分供应商瞬时故障与 Responses payload/SSE 兼容性问题。
- [ ] 设置页添加“测试连接”，同时验证 `/models` 与所选模型的最小化 Responses 流，而不是仅把模型目录成功视为可生成。
- [ ] 在 provider 请求观测中保存脱敏后的 HTTP 状态、各阶段耗时、重试次数及底层连接错误 cause，避免把所有连接超时只显示成 `Request timed out.`。

## 原始错误透传与系统代理修复（2026-08-18）

最终复现确认 Sudochat 的失败发生在 Node 连接层，而不是 Responses 协议层。使用项目锁定的 OpenAI JS SDK 6.26.0、Pi 相同 Session headers 和 300 秒请求 timeout 时，底层原始错误为：

```text
TypeError: fetch failed
caused by ConnectTimeoutError [UND_ERR_CONNECT_TIMEOUT]: Connect Timeout Error
(attempted address: api.sudocode.chat:443, timeout: 10000ms)
```

OpenAI SDK 随后把它统一包装为 `Request timed out.`。本机 Windows 用户代理已启用，地址为 `127.0.0.1:7890`；PowerShell/Codex 使用该代理，因此 Sudochat 可用。Node/Undici 默认不读取 WinINET 系统代理，尝试直连 `168.143.171.93:443` 后连接超时。PPAI 可以直连，所以同一 Iris 链路有时能成功。这解释了两个供应商都可用、Codex 都能调用，但 Iris 表现不同的现象。

实现结果：

- Provider HTTP 非 2xx 现在保留原始 status、status text 和 body；transport failure 保留 `Error -> cause -> AggregateError.errors` 链。只移除已知的 OpenAI/Anthropic/Azure SDK 外层前缀，不改写供应商 body，也不再统一显示 `Request timed out.`。
- Worker 在错误进入 Session 前使用全部已保存 profile Key 和环境 credential 做脱敏；原始 HTTP body 与连接 cause 优先于 Pi/SDK 包装文本。prompt 直接 reject 的异常路径也使用同一原始错误投影。
- Electron main 对所选模型的真实 Base URL 调用 `session.defaultSession.resolveProxy()`，支持 `DIRECT`、`PROXY`、`HTTP` 和 `HTTPS` 结果；解析后的结构化配置通过 Worker protocol v5 传入。Worker 不导入 Electron。
- Worker 使用直接生产依赖 `undici@6.26.0` 的 `ProxyAgent` 创建 provider fetch，并在 Worker runtime 销毁时关闭 dispatcher。PAC、Windows 绕过规则和按目标地址选择代理仍由 Electron/Chromium 负责，不直接读取注册表作为产品逻辑。
- 只返回 SOCKS 且没有 DIRECT fallback 时会明确报不支持；当前本机 HTTP proxy 路径已覆盖。

真实复测使用 `.iris-dev` 已保存的 Sudochat 方案、OpenAI JS SDK 6.26.0、`undici@6.26.0` 和 `http://127.0.0.1:7890` 发起最小 `POST /responses` 流请求，未输出 Key：`2295 ms` 收到 `response.completed`，输出 `OK`。这进一步确认修复点是系统代理接入，不是请求 payload 或供应商可用性。

验证结果：

- `npm run typecheck` 通过。
- protocol、Worker host、Session manager、Pi adapter 定向回归共 4 个文件、47 项通过。
- `npm run agent:worker-check` 首次运行时使用的是已有的旧 `out/main/agent-worker.js`（protocol v4），因此等待 v5 ready 超时；探针源码已更新到 v5。按项目约束未运行 build/dist，需在下一次正常开发构建后执行新产物探针。

- [x] 对 Sudochat 执行使用系统代理的最小 Responses 实测并收到 `response.completed`。
- [x] Provider 错误优先显示脱敏后的原始 HTTP body 或底层 transport cause 链。
- [ ] 下一次正常开发构建后运行 `npm run agent:worker-check`，确认新生成的 Worker bundle 以 protocol v5 完成 ready 握手。
