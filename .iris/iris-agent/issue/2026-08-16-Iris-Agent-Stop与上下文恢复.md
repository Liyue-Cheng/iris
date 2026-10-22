---
title: Iris Agent Stop 结算、历史恢复与真实上下文快照
status: Done
---
## 问题定义

Iris Agent 在流式回答过程中点击 Stop 后，当前 turn 可能被错误记录为 `completed`；随后发送的新消息也不能可靠继承被停止 turn 的用户消息和 assistant partial。与此同时，当前“完整提示词”文件只保存 Iris 在发送前组装的静态层、anchor 和本轮 user request，不是实际交给 provider 的完整上下文，因此无法用它判断模型是否收到了历史消息。

这三个现象共享同一条会话一致性链路，必须一起定义边界，但按风险分阶段落地：

1. turn 在 main 中如何且只能结算一次；
2. app-owned 持久历史如何恢复进新 Worker 内的 Pi Session；
3. 如何在 provider 边界记录真正可核验、可脱敏的请求上下文。

本 Issue 不改变 prompt 内容策略，不引入跨 Session 记忆，不实现文件级 Rewind，也不把 provider 原始响应或凭据写入项目目录。

## 复现与证据

环境：

* Git commit：`805620e09c930fadb0c06140fdf98115995a786f`

* 开发版 `userData`：`C:\Users\liyue\AppData\Roaming\Iris-dev`

* Session：`199b9b8b-944e-4ae6-ac46-b57c063fd694`

复现步骤：

1. 发送“输出一篇2000字的小说”，在流式生成过程中点击 Stop。
2. 发送“继续”。
3. 检查 Session store 和“继续”turn 的完整提示词快照。

实际结果：

* 小说 turn `1060834f-7af9-4960-8aa5-6769274733b2` 保存了 12 字 user message 和 1,682 字 assistant partial，但状态为 `completed`。

* “继续”turn `395719b2-9611-4dc5-8fa8-f1bcc20192c6` 状态也为 `completed`，assistant 内容长度为 0，执行内容转向了当前 anchor，而没有延续小说。

* “继续”快照只含重新组装的 Agent/software/project/anchor 层和 `<user-request>继续</user-request>`，不含上一轮 assistant partial。

证据路径：

* Session store：`C:\Users\liyue\AppData\Roaming\Iris-dev\iris-agent-sessions\82d34fc308d28f11.json`

* “继续”快照：`C:\Users\liyue\AppData\Roaming\Iris-dev\iris-agent-sessions\prompts\82d34fc308d28f11\286a4f6ad2230d80\3565fc509c29b8ea.txt`

## 已确认根因

### Stop 结算竞态

Worker 收到 `abort` 后会等待 `runtime.session.abort()`。Pi 在这个 Promise 返回前先发出 aborted `message_end` 和 `agent_end`；main 当前在 `agent_end` 上调用 `completeActiveTurn()`，先把 turn 标为 `completed` 并清空 `activeTurnId`。Worker 随后发出的 `interrupted` 已找不到 active turn，无法再改成 `stopped`。

### 历史恢复没有接入 Pi

`AgentWorkerHost` 会读取 `store.history()` 并把 `initialize.history` 发给 Worker，但 `src/main/agent-worker.ts` 只回显 `history.revision`，没有消费 `history.messages`。`createIrisPiSession()` 仍使用空的 `SessionManager.inMemory(cwd)`，所以 Worker 空闲退出、崩溃或应用重启后，模型上下文都会丢失。

### 快照层级错误

`src/main/agent/session-manager.ts` 在发送前保存 `preparePrompt()` 的字符串。该字符串是 Iris 组装给 Pi 的本轮输入，不包含 Pi Session 持有的消息历史、context transform/compaction 结果、工具定义或 provider 调用循环，因此不能称为完整 provider prompt。

## 正确性不变量

实现必须同时满足：

* 一个 turn 只能发生一次终态结算，终态之间不能互相覆盖。

* main 是 turn 状态和 stop intent 的唯一所有者；Worker 事件只是带关联信息的事实输入。

* 一旦 main 接受 Stop 请求，相关 turn 不能再从 `stopping` 进入 `completed`。

* Stop 前已经收到的 assistant partial 必须保存在会话历史中，并在下一轮可作为历史上下文恢复。

* canonical history 不依赖某个 Worker 是否仍然存活。

* Rewind 后只恢复保留分支，不得把已截断消息重新注入 Pi。

* “provider 上下文”必须表示 context transform、裁剪/压缩以及工具装配完成后，实际进入 provider 调用的数据。

* 凭据、认证 header、API key 和 provider secret 永远不进入快照。

* 一个 turn 内可能发生多次 provider 调用；快照必须保留调用顺序，不能用一个字符串假装只有一次 prompt。

## 解决方案

### 一、修复 Stop 状态机和单次结算

在 main-owned Session 运行态中为 active turn 增加明确的 stop intent，例如 `stopRequestedAt`，并以 `sessionId + requestId + turnId` 关联 Stop 命令和 Worker 回执。持久化字段是否需要跨进程保存由实现时决定，但 app 退出恢复时任何未结算的 running/stopping turn 都必须按中断恢复，不能伪装成 completed。

建议状态流：

```text
running --Stop accepted--> stopping --matching interrupted/abort ack--> stopped
running --normal agent_end/settled-------------------------------> completed
running --failure-----------------------------------------------> failed
stopping --late agent_end---------------------------------------> stopping
terminal --duplicate or late event------------------------------> unchanged
```

main 接受 Stop 后立即记录 intent，再向 Worker 发 `abort`。当处于 `stopping` 时，aborted `agent_end` 只允许刷新已收到的 partial/event，不得调用完成结算。只有匹配当前 turn 的显式 `interrupted` 或 abort acknowledgement 才结算为 `stopped`。若 Worker 在确认前退出，则由 host 的退出恢复路径把该 turn 结算为 `stopped` 或明确的 interrupted 状态，而不是 `completed`。

将 `completeActiveTurn()` 与 `finishActiveTurnAs()` 收敛到一个 compare-and-set 风格的结算入口：它必须校验 session、request、turn、当前非终态和预期运行阶段。重复、乱序和上一请求遗留事件应成为无副作用操作，并留下可诊断日志。

待实施：

* [x] 为 active turn 增加 main-owned stop intent 和完整 correlation，先记录 intent 再发送 `abort`。

* [x] 统一 completed、stopped、failed 的结算入口，并保证终态 compare-and-set 幂等。

* [x] 在 `stopping` 阶段忽略或延后 aborted `agent_end` 的完成语义，同时继续保存 assistant partial。

* [x] 让 Worker 的 stop acknowledgement 携带并校验 `sessionId`、`requestId`、`turnId`。

* [x] 定义 Worker 退出、崩溃和 app 重启时 running/stopping turn 的恢复状态。

### 二、建立可恢复的 canonical history

继续以 app-owned Session store 为跨 Worker 的历史真相源，但不要把 Renderer 投影直接塞给 Pi。新增单一、经过测试的转换层，把保留分支上的 Iris user/assistant/tool 事实按原顺序转换为 Pi 接受的 `AgentMessage` 或 Session entry。

转换规则至少要明确：

* completed turn：恢复 user、assistant 和 Pi 继续推理所需的工具调用/结果。

* stopped turn：恢复 user 和已持久化的 assistant partial，并保留 aborted/stopped 语义；不得补造一个完整回答。

* failed turn：只恢复 provider 实际已经看到且后续上下文应该继续携带的消息，错误展示事件不伪装成对话消息。

* rewound history：只转换当前 revision 保留的消息，不读取被截断分支。

* 空 assistant、重复工具结果、未闭合 tool call：按 Pi/provider 的合法消息约束归一化，不能构造会被 provider 拒绝的序列。

Worker 初始化时先用该转换结果填充 Pi 的 in-memory `SessionManager`，再创建/启用 Agent Session。`ready` 不只回显收到的 revision，还要确认实际加载的 revision 和可核验的消息数量或摘要。发送首条新请求前，host 必须确认 Worker ready 对应当前 canonical revision；若初始化期间历史变化，应重建或重新同步，不能在旧历史上继续。

长期上，canonical history 的 schema 应独立于当前 UI 卡片结构和具体 Pi SDK 版本。SDK 适配集中在 `pi-adapter`/history adapter 中，升级 Pi 时只迁移这一层。

待实施：

* [x] 定义 Iris canonical history schema 与 Pi message/session entry 的显式转换规则。

* [x] 把 stopped assistant partial、工具调用和工具结果纳入合法、顺序稳定的恢复模型。

* [x] 在 `createIrisPiSession()` 创建会话前填充 Pi `SessionManager`，不再丢弃 `initialize.history.messages`。

* [x] 强化 ready 握手，校验 Worker 实际加载的 history revision 与摘要。

* [x] 处理初始化期间 revision 变化，禁止新请求在陈旧历史上发送。

* [x] 保持 Rewind 后只恢复当前保留分支。

### 三、把“完整提示词”升级为真实 provider 上下文包

把现有 `preparePrompt()` 产物正式命名为 `assembled-input`。它可继续作为诊断材料，但不能再被 UI 或文件内容描述为完整 provider prompt。

在最接近 provider 请求的边界捕获实际 payload：应位于 Pi 的 context transform/compaction、消息归一化和工具 schema 装配之后、网络发送之前。优先使用 Pi 提供的 `onPayload` 能力，并确认它与 `createAgentSession` 内部 extension hook 的 `onPayload` 可以组合；如当前 SDK 把该 hook 私有占用，则在 adapter 层增加组合/暴露点，不能绕开正常 provider 转换自行重建一个“看起来相同”的 payload。

每个 turn 保存一个 context bundle，而不是单一 `.txt`：

```text
turn-context/
  index.json
  call-000.json
  call-000.txt
  call-001.json
  call-001.txt
```

`index.json` 记录 schema version、session/turn、provider、model、调用顺序、时间、assembled-input artifact、是否发生 compaction/cropping 以及每个调用文件的哈希。每个 `call-NNN.json` 保存脱敏后的 system prompt、ordered messages、工具定义或稳定 fingerprint，以及 provider 所需的非敏感参数；`.txt` 是从同一 JSON 确定性生成的人类可读视图，不能成为另一份真相源。

工具循环会产生多次 provider 调用，每次调用都追加一个有序条目。输入卡片和最终 assistant 卡片都打开同一个 turn context bundle/index；assistant 卡片是否显示入口仍取决于产品对“最终输出”的定义，但不得指向点击时重新组装的最新 prompt。

脱敏在落盘前完成，采用 allowlist 序列化，不保存请求 header、credential 对象和原始环境变量。对文本内容只移除已知 secret 来源，不任意改写用户正文；无法证明安全的 provider 扩展字段默认丢弃。落盘继续位于 app `userData`，Renderer 只传 project scope、session 和 turn 标识，不能传任意路径。

待实施：

* [x] 将当前 prompt artifact 标记为 `assembled-input`，修正 UI 和数据字段的语义。

* [x] 验证并接入 Pi/provider 边界的 `onPayload`，与 extension hook 正确组合。

* [x] 定义 versioned context bundle schema 和多次 provider 调用的顺序模型。

* [x] 实现 allowlist 序列化与落盘前 secret 脱敏，并对输出做安全测试。

* [x] 从结构化 JSON 确定性生成可读 `.txt` 视图。

* [x] 让两个卡片入口按内部标识打开同一个 turn context bundle，不接受 Renderer 任意路径。

## 兼容与迁移

已有 `promptAvailable` 和 `.txt` 快照保留可读，但迁移后必须展示为“组装输入（旧版）”或同等明确名称。不能把旧文件静默解释成 provider context，也不能为旧 Session 编造当时不存在的 provider payload。

建议引入带版本的 artifact metadata，并允许三种能力独立存在：`assembledInputAvailable`、`providerContextAvailable`、`providerCallCount`。旧数据在读取时映射为 legacy assembled input；新 turn 根据实际捕获结果逐步展示 provider context。迁移失败不得影响会话正文读取或 Agent 继续运行。

待实施：

* [x] 增加 artifact schema version 和 legacy 读取适配。

* [x] 将旧 `promptAvailable` 精确迁移为 legacy assembled-input 能力，不伪造 provider context。

* [x] 保证旧 Session、旧 Rewind 节点和缺少快照的 turn 仍可读取。

* [x] 对 context bundle 写入采用临时文件加原子替换，避免崩溃留下半个索引。

## 自动化验证

Stop 状态机使用可控事件序列测试，不依赖真实 provider 时序：

* [x] 覆盖 `running -> Stop -> agent_end -> interrupted`，最终只能是 `stopped`。

* [x] 覆盖 `interrupted -> agent_end`、重复 `agent_end`、重复 `interrupted` 和旧 request 晚到事件，终态保持不变。

* [x] 断言 Stop 前 assistant partial 完整保留，空 partial 也不会被误标 completed。

* [x] 覆盖 Stop acknowledgement 前 Worker 正常退出、崩溃及应用恢复。

历史恢复测试必须断言 Pi 实际收到消息，而不只断言 `loadHistory()` 被调用：

* [x] 覆盖 Worker 空闲退出后重建、崩溃后重建和 app 重启恢复。

* [x] 覆盖 stopped turn 的 user message 与 assistant partial 被按顺序注入。

* [x] 覆盖 Rewind 后被截断消息不再进入 Pi。

* [x] 用“小说被停止后发送继续”的固定 fixture 断言 provider-bound messages 含上一轮 user 和 partial assistant。

* [x] 覆盖 tool call/result 恢复后的消息序列满足 provider 约束。

上下文快照测试直接检查 provider-bound capture：

* [x] 断言快照含历史、当前 user message、system prompt、provider/model 和工具信息。

* [x] 断言 API key、认证 header、credential 与已知 secret 不落盘。

* [x] 覆盖一次 turn 内多次 provider 调用，调用编号和内容顺序稳定。

* [x] 断言 `.txt` 与结构化 JSON 来自同一份已脱敏数据。

* [x] 覆盖旧 assembled-input artifact 的显示名称和打开行为。

## 实施顺序

按以下顺序提交和验收，避免快照改造掩盖会话正确性问题：

* [x] 第一阶段：修复 Stop intent、correlation 和单次终态结算，完成事件乱序测试。

* [x] 第二阶段：实现 canonical history 转换、Pi Session 注入和 revision ready 校验。

* [x] 第三阶段：将快照改为 provider context bundle，并完成 legacy 迁移。

* [x] 每阶段运行相关 Vitest 和 `npm run typecheck`；全部完成后运行完整测试，但不运行 `npm run build`、`npm run dist` 或开发服务器截图。

* [ ] 在真实产品入口复测 Stop 后“继续”、Worker 空闲重建、应用重启和 Rewind。

## 完成标准

* [x] 点击 Stop 后，无论 Pi 事件顺序如何，目标 turn 最终且永久为 `stopped`。

* [x] 已显示的 assistant partial 在刷新、Worker 重建和应用重启后仍存在。

* [ ] 下一轮真实 provider 请求包含保留历史中的上一轮 user message 和 stopped assistant partial。

* [x] Rewind 后 provider 请求不包含已截断分支。

* [x] “完整上下文”入口能逐次展示该 turn 实际发送给 provider 的脱敏 payload，并明确区分 legacy assembled input。

* [x] 所有新增状态机、恢复、迁移、安全和多调用测试通过，`npm run typecheck` 通过。

## 实施结果（2026-08-16）

实现已按三个阶段落地，Issue 推进到 `In Review`，等待真实产品入口验收。

### 状态机与恢复

* main Session 持久化 `stopRequestedTurnId`，在发送 abort 前强制 flush，并以
  `sessionId + requestId + turnId` 校验所有流、状态、工具与终态事件。

* completed、failed、stopped 统一经过单次 compare-and-set 结算；stop intent 对
  `agent_end`、failure、Worker 退出和 app 重启恢复具有优先级，晚到和重复事件无副作用。

* Worker 事件按 Session 串行处理；Stop 时已经显示的 partial 与 intent 一起持久化。

### Canonical history

* app store 保存可恢复的 Pi `providerMessage`，包括 user、assistant tool call 和 tool result；
  legacy 文本消息由 `pi-adapter` 归一化为合法 Pi message。

* Worker 初始化先填充 in-memory `SessionManager`，再创建 Agent；ready 同时核对 revision 和
  Pi 实际加载的消息数。活动 turn 不进入初始化历史，避免首条请求重复；Rewind 会销毁旧 Worker，
  下一次请求只从保留分支重建。

### Provider context artifact

* Pi `ModelRuntime.streamSimple()` 的 `onPayload` 与原 hook 组合，捕获 extension/context
  transform、消息转换和工具装配之后的实际 provider payload。

* 每个 turn 使用 `<turn>.context/`，包含原子提交的 `index.json`、确定性 `index.txt` 以及
  `call-000.json/.txt` 等有序调用文件；index 记录 provider/model/API、相对文件名和 SHA-256。

* Worker 落盘前按顶层 allowlist 序列化，丢弃 header、credential 和未知 provider 扩展字段，
  并用已存凭据及 secret 型环境变量的实际值做正文替换；main 再执行一次防御性清洗。

* 旧 `promptAvailable` 只迁移为 `assembledInputLegacy`，UI 显示“组装输入（旧版）”；新 turn 的
  user/assistant 两个入口都只传 scope、sessionId、turnId，并打开同一 context index。

### 验证

* `npm run typecheck`：通过。

* 相关 Vitest：6 个文件、24 个测试通过。

* 完整 Vitest：74 个文件、400 个测试通过。

* 按项目约束未运行 `npm run build`、`npm run dist`，也未启动开发服务器或用截图替代人工测试。

待人工验收：

* [ ] 生成新构建后运行 `npm run agent:worker-check`，确认 Electron Worker 使用 protocol v2；当前 `out/` 未在本轮重建。

<br />

<br />

<br />

还是有bug

**You**

生成一个5000字的小说

**Iris Agent**

\# 守钟人  钟楼在城西已经站了一百二十年，比镇上最老的人还要老上两辈。每天清晨五点，那口青铜大钟会准时响三下，声音荡过青瓦屋顶，落进每一条还没睡醒的巷子。镇上的人从不看表，钟声一响，卖豆腐的推车就吱呀呀地出了门，学生揉着眼睛往学校走，药铺的伙计把门板一块块卸下来。没人问过这钟是谁敲的，也没人知道，敲钟的人住在钟楼顶层那间连窗户都没有的小屋里，已经守了整整四十年。  他叫老周，没有结过婚，没有儿女。镇上的人只知道钟楼里住着个修钟的，谁家的挂钟慢了、停了，送到钟楼底下的木箱子里，第二天取回来准走得又准又稳。老周修钟不收钱，只在箱子边放个粗瓷碗，愿意的扔几个铜板，不愿意的也没人说什么。  老周这辈子最怕两件事：一是钟停了，二是人走了。  钟停了，他就得爬进那口大钟后面的机芯房里去。机芯房里满是黄铜的齿轮，大的有磨盘那么粗，小的细如缝衣针。它们咬合在一起，一层叠一层，像一座用金属织成的塔。老周熟悉每一枚齿轮的声音，哪一枚该上油了，哪一枚磨损得该换了，他只要把耳朵贴在铁壳上，就能听出来。他常说，钟不是用眼睛修的，是用耳朵修的。  人走了，他却没有办法修。四十年前，他母亲走的那天，钟楼的大钟忽然慢了一刻钟。老周在葬礼上听见钟声迟迟不来，心里咯噔一下，跑回钟楼，发现是驱动发条的黄铜链断了一节。他把链子接上，把钟调准，却总觉得，从那以后，钟声里多了一丝不易察觉的颤音。  镇上有个女孩叫小满，今年十二岁，每天放学都从钟楼下面经过。她喜欢仰头看那口大钟，看阳光落在铜钟上，泛起一圈一圈的金色。有一天，她鼓起勇气，沿着钟楼外盘旋而上的木楼梯，一直走到了顶层。  老周正在小屋门口磨一枚小小的齿轮，听见脚步声，抬头看见一个扎着两根辫子的女孩，脸晒得红扑扑的，额头上都是汗。  “爷爷，你是神仙吗？”小满问。  老周笑了，脸上的皱纹挤在一起：“不是，我就是个修钟的。”  “那你怎么能让全城的人都知道现在几点了？”  老周放下锉刀，指了指身后的机芯房：“不是我让他们知道，是它让他们知道。我只是替它看着点，别让它走岔了路。”  小满探头往机芯房里看，只见无数齿轮在阴影里缓缓转动，发出一种低沉而绵长的声响，像有什么巨大的、看不见的东西在呼吸。  “我也想看看。”小满说。  老周想了想，从兜里掏出一块白布，擦了擦手，说：“想看可以，但不能碰。钟这东西，你碰它一下，它就走不准了。”  从那

Stopped by user【我在这里故意停止的】

**You**

刚刚网断了，你现在继续编写

**Iris Agent**

网断了导致上一段内容没能保存下来，我这边也拿不到中断前的残稿。我直接把这篇小说完整重写一遍给你，约 5000 字。  ---  # 雾中来信  ## 一  陈默是在凌晨三点被电话吵醒的。  来电显示是一个陌生号码，归属地是邻省的一座沿海小城。他做的是旧书收购的生意，手机常年不关，因为总有老人会在深夜想起一柜子要处理的书。可这次电话那头没有老人的声音，只有一片潮湿的风声，像有人把听筒举在了海边。  “喂？”陈默说。  风声持续了大约十秒，然后一个女声轻轻地说：“你那里，还收信吗？”  陈默一愣：“信？我是收旧书的……”  “对。”女声说，“是一箱子信。很多年以前的了。”  陈默揉了揉眼睛，看了眼窗外。城市还沉在雨里，玻璃上蒙

Stopped by user.

<br />

【这就是之前的bug，现在还是完全没修】

## 真实入口复测调查（2026-08-17）

本次复测运行的是开发服务器和新 Worker 实现，不是旧 `out/` Worker。新 Session
`14a4fa45-bef3-47e0-8175-fce2ecda890b` 的三个 turn 均已保存为 `stopped`，均有
`providerContextAvailable: true`。这证明 Stop 状态机与 provider context 捕获已在实际运行，
不是因为未重建 Worker 导致修复未生效。

### 现场证据

Session store 中的小说 turn `d7464503-65c9-4e85-96b4-1e100ce80e9d` 完整保留了：

* user：“生成一个5000字的小说”，12 字；
* assistant partial：《守钟人》，992 字；
* assistant `providerMessage.stopReason`：`aborted`。

下一个“刚刚网断了，你现在继续编写”turn
`2403a96e-bfb8-4348-860d-addff85a6a12` 的真实 provider 快照位于：

`C:\Users\liyue\AppData\Roaming\Iris-dev\iris-agent-sessions\prompts\82d34fc308d28f11\5a7ecc21e134dfce\f97bacc2e5d51e21.context\call-000.txt`

该 TXT 的 `messages` 实际顺序是 `system, user, user, user`，assistant 数量为 0。三个 user
分别是三个 turn 的 assembled input；《守钟人》partial 和更早的 assistant 回答均未进入
provider payload。三次 provider 快照的角色序列也依次是：

```text
system,user
system,user,user
system,user,user,user
```

因此模型回答“拿不到中断前的残稿”与它实际收到的 payload 一致，不是模型忽略了已提供的上下文。

### 根因

Iris 在 `src/main/agent/pi-adapter.ts` 中把 canonical history 追加到 Pi `SessionManager`，
并且 Session store 中的 assistant partial 也确实存在。但 Pi AI 0.84.1 在
`dist/api/transform-messages.js` 的 provider 转换阶段明确过滤所有
`stopReason === "error" || stopReason === "aborted"` 的 assistant message。Pi 的注释说这是为了避免
重放不完整 reasoning 或 tool call 造成 provider API 错误。

现有恢复链路因此只保证了 assistant partial 进入 Pi Session 的过滤前上下文，没有保证它
进入 provider-bound context。无论 Worker 是否重建，只要 partial 保留 `aborted` 语义，Pi 都会在最后一步把它删掉。

### 测试为什么误报通过

`src/main/agent/pi-adapter.test.ts` 中名为“stopped assistant partial”的 fixture 实际使用
`stopReason: 'toolUse'`，而不是 `aborted`。该测试只断言
`SessionManager.buildSessionContext().messages`，没有经过 Pi AI `transformMessages()` 和 provider adapter。
所以它验证的是“消息被装入 Pi Session”，却被当成了“消息已进入真实 provider 请求”。

Issue 中原先勾选的“小说被停止后发送继续的 provider-bound fixture”在当前测试代码中并不存在，
已将相关勾选退回未完成。

### 修复边界

不能直接把整条 aborted `providerMessage` 改成正常 assistant 后原样重放；其中可能包含未完整的
thinking、tool call 或 provider-specific metadata，这正是 Pi 过滤它的原因。需要在 Iris 的 Pi 适配层将
stopped assistant 归一化为只含已显示文本的、provider-safe 的历史 assistant message，同时保留
app-owned turn 的 `stopped` 终态；两者不能共用同一个 `stopReason` 语义。

* [x] 在 Pi adapter 中为 stopped assistant partial 生成只含已显示 text 的 provider-safe 恢复消息，不重放 thinking、tool call 或断裂的 provider metadata。
* [x] 增加真正经过 Pi AI provider 转换边界的回归测试，fixture 必须使用 `stopReason: 'aborted'`，并断言 payload 含上一轮 partial text。
* [x] 覆盖 stopped partial 含 thinking、未闭合 tool call、空 text 和跨 provider/model 恢复，确保归一化后的消息序列合法。
* [ ] 在开发服务器真实复测 Stop 后“继续”，并用新 `call-000.txt` 确认历史 assistant partial 已进入 provider payload。

## 全面整改实施结果（2026-08-17）

`src/main/agent/pi-adapter.ts` 现在在每次 `ModelRuntime.streamSimple()` 进入 Pi provider
转换前执行统一的 context 归一化，因此同时覆盖存活 Worker 的下一轮与 Worker 重建后的恢复轮：

* `stopReason: aborted` 且已有可见 text 的 assistant 被投影为 `stopReason: stop` 的合成历史 assistant；
* 只复制普通 text 字节，不重放 thinking、thinking/text signature、response id、未完成 tool call 或其他 provider-specific metadata；
* 被丢弃 tool call 的对应 tool result 同步丢弃，避免构造 orphaned tool result；
* 没有可见 text 的 aborted assistant 不进入 provider history；
* app-owned turn 仍保持 `stopped`，只有临时 provider context 投影使用合法的 `stop` 语义。

该归一化与 provider context 快照共用同一 ModelRuntime 包装层，但不依赖快照回调是否存在；
关闭观测或快照落盘失败不会再改变会话正确性。

新回归测试通过当前锁定的 Pi Coding Agent 0.84.1 公开 `ModelRuntime`、DeepSeek
OpenAI-compatible adapter 和 `onPayload` 边界捕获真实 provider payload，不再只检查
`SessionManager.buildSessionContext()`。测试在 payload 生成后立即 abort，不发出网络请求。真实中文 fixture 覆盖“生成一个5000字的小说”、
《守钟人》partial 与“刚刚网断了，你现在继续编写”，并断言 provider-bound 序列为
`user, assistant, user`。另一条用例覆盖 persisted aborted `providerMessage` 经 Pi Session 恢复后仍能进入
provider transform。

验证结果：

* `npm run typecheck`：通过；
* Iris Agent 相关 6 个测试文件：27 项通过；
* Pi adapter：8 项通过；
* 完整 Vitest 使用单 worker 运行：74 个测试文件、404 项全部通过。默认并发首轮曾出现一次
  Windows 临时目录原子 `rename EPERM`，失败文件单独复跑和单 worker 全量复跑均通过。

按项目约束未运行 `npm run build`、`npm run dist`，也未启动开发服务器或用截图替代人工验收。

## Rewind 全面审计（2026-08-17）

### 结论

当前 Rewind 的纯数据截断只保留目标 completed turn，并同步删除其后的 message、tool event、
file effect 和 request fact；下一次新建 Worker 时，`store.history()` 也只会读取保留分支。
这部分线性历史逻辑本身没有发现类似 Pi provider 转换过滤 assistant 的问题。

但 Rewind 还不是一个完整的会话事务。生产路径缺少 Session 级命令串行化、Worker 启动取消和
旧 Worker generation 隔离，已经可以从现有代码构造出两条确定的高风险竞态。原先“Rewind 后只恢复
当前保留分支”的测试只覆盖纯 reducer，没有覆盖真正的 manager、Worker 生命周期和 provider 边界，
因此该勾选只能证明静态数组截断，不能证明运行时不执行或不恢复旧分支。
上文四项相关勾选已退回未完成，等待生产事务和 provider-bound 回归同时成立后再恢复。

### 高风险一：初始化中的 Worker 无法被 Stop 或 Rewind 关闭

`AgentWorkerHost.start()` 先异步读取 history/runtime，之后才创建 Worker 并写入 `this.worker`。
`shutdown()` 只检查 `this.worker`；当启动 Promise 仍在前半段、`this.worker === null` 时会直接返回，
既不等待也不取消 `startPromise`。

WorkerHost 当前异步接口允许的时间线如下：

1. `send()` 已把新 turn 写为 running，并在 `host.post()` 中等待 `ensureStarted()`；
2. `start()` 尚在读取 history/runtime，host 的 `running` 仍为 false；
3. 用户 Stop，main 因看不到 running Worker 直接把 turn 结算为 stopped；
4. 用户 Rewind，`shutdown()` 再次因 `worker === null` 直接返回，并从 manager 删除 host；
5. 原 `startPromise` 随后继续创建一个已脱离 manager 所有权的 Worker，`post()` 还会向它发送已被
   Rewind 删除的旧 run；该 Worker 可以继续调用 provider，事件则因 correlation 不匹配而大多被 UI 丢弃。

当前生产的 history/runtime loader 通常在下一个 microtask 就完成，所以正常按钮操作撞中第 2 步的窗口
很窄；但 host 的接口明确允许异步 loader，且没有 cancellation 或 generation 校验，现有测试也没有证明
该窗口不可达。会话正确性不能依赖 loader 永远不引入磁盘 I/O 或其他延迟。

这违反“Rewind 时没有进行中模型请求”和 Stop 的用户预期；最坏结果不是旧文字重新显示，而是用户已经
停止并回退后，旧请求仍在后台产生 provider 调用。

### 高风险二：Rewind 与 Send 可以交错并产生 split-brain

`rewind()` 先 `store.upsert()` 写入 idle 的截断快照，再 `await host.shutdown()`，最后才删除 host 和
emit。IPC 没有 Session 级互斥；Renderer 的 `dedupeKey` 只用于错误通知，也不阻止不同动作并发。
因此 shutdown 等待期间可以立即进入另一个 `send()`：它会基于已截断的 idle store 新建 running turn，
但 `hostFor()` 仍取到即将终止的旧 host。

随后可能出现三种不一致结果：run 被投递给正在 terminate 的 Worker 后丢失；`post()` 在 await 后访问
已经变成 null 的 `this.worker` 并失败；或 Rewind 最后 emit 较旧的 `rewound` 对象，覆盖 Renderer 已收到的
新 running 快照。main store、Renderer 投影和真实 Worker 是否存活可能各自不同。相同问题也存在于
并发 send/send、rewind/close 等入口，不能只靠按钮 disabled 修复。

### 中风险缺口

* Rewind 没有加入 `workerEventChains`。旧 Worker 的 `ready` 和不带 turn 的 `state` 事件在截断后仍可把
  Session 从 idle 改成 ready/starting 等状态；带旧 turn correlation 的 stream、tool 和 provider context
  通常会被拒绝，但目前没有 Worker instance/generation token 保证所有旧事件统一失效。
* Rewind 的 `store.upsert()` 使用 150 ms debounce，返回前不 `flush()`。应用异常退出落在该窗口内时，
  磁盘仍可能保留被截断后缀，重启后旧分支复活。Stop intent 已采用显式 flush，Rewind 作为破坏性历史
  操作也需要明确 durability commit point。
* 生产 reducer 只检查目标 turn 的 `status === completed`，没有验证该 turn 的 tool events 全部结算；
  独立的 `history.ts` 虽然计算“无 pending tool”的 completion node，但生产 Rewind 没有使用它。正常事件
  顺序通常能满足条件，异常恢复或竞态数据则没有防线，与产品文档的完成节点不变量不一致。
* reducer 把状态改为 idle，却保留 suffix 失败留下的 `lastError`。当前 UI 主要显示 turn.error，影响有限，
  但会留下互相矛盾的 Session API 状态，应在 Rewind commit 时清空。
* 被截断 turn 的 assembled-input/provider-context artifact 不会删除，并成为产品内不可访问的孤儿。
  这不会把旧分支重新注入模型，但需要明确保留期限和隐私/磁盘清理策略，不能把“UI 不可恢复”等同于
  “数据已删除”。

### 测试盲区

现有 `session-manager.test.ts` 仅直接调用 `applyIrisAgentMessageRewind()`，没有实例化
`IrisAgentSessionManager`；`history.test.ts` 测的是未接入生产路径的另一套 linear-history helper；
`worker-host.test.ts` 只覆盖正常启动、ready 校验和已启动 Worker 的 shutdown，没有覆盖启动中 shutdown。
目前也没有“Rewind -> 新 Worker -> Pi provider payload”的端到端回归测试，所以此前测试全绿不能排除
上述竞态。

### 整改边界

* [x] 为每个 Session 建立 main-owned 命令事务/串行化边界，覆盖 send、stop、retry、rewind、close 和
  Worker 生命周期变更；Renderer busy 状态只能改善交互，不能充当正确性锁。
* [x] 为 `AgentWorkerHost` 增加可取消的启动 generation：shutdown 必须使 in-flight start 失效并等待清理，
  `post()` 在 await initialization 后必须重新验证同一 generation 和同一 Worker 仍有效。
* [x] Rewind 先隔离旧 host 和旧 generation，等待其启动/执行/事件链完成或失效，再基于最新 store 二次
  校验目标并一次性提交截断；任何旧 Worker 事件都不得改变新 generation 的 Session。
* [x] 把 Rewind 的持久化 flush 设为返回前的 commit point；flush 失败时不得向 Renderer 宣告成功。
* [x] 在生产入口校验“Session 无模型请求、无工具执行、目标 completed 且工具全部结算”，并清空
  `lastError`；不要依赖未接线的 `history.ts` 测试代替生产校验。
* [ ] 增加 manager/host 并发回归：启动中 Stop+Rewind、idle Worker Rewind+立即 Send、双 Send、
  queued old event、tool completion、close/project switch，以及 terminate/post 的不同完成顺序。
* [x] 增加真实 provider-bound Rewind fixture：被截断分支含 assistant、aborted partial、tool call/result 时，
  新 Worker 的 payload 只含保留分支，并断言旧请求在 Rewind commit 后没有 provider 调用。
* [ ] 明确并测试被截断 context artifact 的保留/清理策略。

## Rewind 整改实施结果（2026-08-17）

main 现在为每个 Session 维护独立命令链，`send`、`stop`、`retry`、`rewind`、`close` 和项目关闭
不再交错修改同一个 Session。Stop 会排在仍在初始化的 Send 之后立即发送带完整 correlation 的 abort；
双 Send 的后一个请求会在读取最新 running 状态后明确拒绝，不再用旧 clone 覆盖第一个 turn。

Rewind 的事务顺序改为：校验停止态和目标 -> 从 manager 隔离旧 host -> shutdown Worker -> 排空已经
入队的旧 Worker 事件 -> 重新读取并二次校验最新 Session -> 截断 -> `flush()` -> emit。Rewind 进行中
到达的 Send 会在同一 Session 命令链等待，提交后只会创建新 Worker；旧 host 的 event/error/crash
listener 还会检查自己是否仍是 manager 当前实例，所以无 turn 的旧 `ready/state` 也不能污染新状态。

`AgentWorkerHost` 使用启动 generation 和共享 shutdown Promise。shutdown 会先使 generation 失效，
终止已创建 Worker，并等待 in-flight start 收敛；`post()` 在 ready 后再次核对 generation 和 Worker
实例。manager 退出时先封闭新命令并终止 host，再等待命令链并二次清理期间出现的 host，避免等待一个
永远收不到 ready 的 Send，或遗漏仍在异步准备 prompt 的 Send。

Session store 的 `updatedAt` 现在对同一 Session 严格单调；Renderer 会拒绝较旧的 Session 快照，
因此较晚返回的 Rewind IPC 结果不能覆盖已经到达的新 running event。Rewind reducer 同时拒绝目标 turn
仍有 running tool event 的异常数据，并清空 suffix 遗留的 `lastError`。

新增集成测试直接实例化 `IrisAgentSessionManager` 和可控 Worker：覆盖双 Send、阻塞 terminate 时
Rewind+立即 Send、旧 Worker 晚到 state、新 Worker history 只含保留 turn，以及旧 Worker 不再收到
新 run。WorkerHost 单测覆盖 shutdown 取消延迟 history loader，且 Worker 尚未创建时 pending post 必须
失败。真实 Pi `ModelRuntime`/DeepSeek `onPayload` fixture 从 reducer 生成 Rewind 前缀，被删除分支包含
aborted assistant、tool call/result，并断言最终 provider payload 只含保留问答和 Rewind 后的新请求。

验证结果：

* `npm run typecheck`：通过，包含 main、preload、web 和 async boundary check；
* Iris Agent 相关 11 个测试文件：48 项全部通过；
* 单 worker 完整 Vitest：74 个测试文件、410 项全部通过。

按项目约束未运行 `npm run build`、`npm run dist`，也未启动开发服务器或使用截图代替人工验收。
被截断 context artifact 当前仍保留在 userData，保留期限和清理策略继续作为显式待办；更宽的
tool completion、close/project switch 交错压测也未冒充已完成。

## Stop 后重试 400 现场整改（2026-08-17）

### 现场现象与证据

用户在开发服务器中停止当前回答后点击重试/继续，连续收到：

```text
400: {"message":"Messages with role 'tool' must be a response to a preceding message with 'tool_calls'","type":"invalid_request_error","param":null,"code":"invalid_request_error"}
```

开发版 `userData` 中受影响 Session 为
`77d007a0-64a4-414d-a5ec-b62dc630c40b`，Session store 为
`C:\Users\liyue\AppData\Roaming\Iris-dev\iris-agent-sessions\82d34fc308d28f11.json`。
第一个 stopped turn `0d7ae5e4-2428-491b-bea8-fba154acfd65` 的最终 aborted assistant 只含
tool call `call_00_WoZK90xj1ofd2WRpTbL87334`，但同一 turn 还保存了另外两个 tool result：

```text
call_00_TMpxY4dY2kymcEZbAFrp9635
call_00_irOOH9GtKXJWhHcj8nQS2304
```

失败请求的 provider context 中，两个 `tool` message 前只有不含 `tool_calls` 的 stopped assistant
文本。更早的成功快照则明确包含
`assistant(tool_calls=TMpx) -> tool(TMpx) -> assistant(tool_calls=irOO) -> tool(irOO)`。
因此 400 是 Iris 构造出的历史序列非法，不是 provider 忘记上下文，也不是网络恢复后模型自身拒绝续写。

### 两层根因

`session-manager.ts::applyProviderMessage()` 原先把同一 turn 的每个 provider assistant
`message_end` 都覆盖到唯一的 app assistant message。工具循环中的中间 assistant tool-call envelope
因此被后续最终/aborted assistant 覆盖，而 tool result 仍作为独立 app message 保留。

此前 `normalizeIrisProviderContext()` 只记录当前 aborted assistant 中被删除的 tool call ID，并删除
这些 ID 的结果。现场 orphan result 属于更早且已经从 canonical history 消失的 assistant，ID 不在该
局部集合中，所以继续穿过 Pi adapter 到达 OpenAI-compatible provider，触发协议级 400。

### 整改实现

Provider 投影现在对完整序列做结构校验，而不是只处理 aborted assistant 的局部 ID：

* assistant 的多个 tool call 与其后连续 tool result 被视为一个原子组；
* 只有所有 call ID 均有且只有一个匹配结果时才保留该组；
* 孤立结果、重复结果、未知 ID、错位结果一律删除；
* assistant 有可见文本但工具结果不完整时，降级为只含 text 的 provider-safe assistant；
* aborted assistant 继续只恢复已显示 text，不恢复 thinking、signature、tool call 或 provider metadata。

该投影在每次 `ModelRuntime.streamSimple()` 调用前执行，因此无需迁移旧 Session；现场已经落盘的 orphan
result 会在下一次请求前直接被剔除。

Canonical history 同时修复：tool-use assistant 不再覆盖 turn 的主 assistant，而是以 provider-only
message 插在对应 tool result 前；tool result 与后续 tool-use assistant 都插在最终可见 assistant 前，
形成稳定的 `assistant(toolCall) -> toolResult -> final assistant` 顺序。流式 text 只更新 turn 的主
assistant，Renderer 也只显示主 assistant，中间 provider-only message 不产生重复卡片。Session store
加载时校验 `compact` 和 `providerOnly` 类型，避免损坏数据用 truthy 非布尔值改变历史或显示语义。

### 回归与验证

Pi adapter 回归通过锁定的 Pi Coding Agent 0.84.1 公开 `ModelRuntime`、DeepSeek adapter 和
provider `onPayload` 捕获真实 payload，payload 生成后立即 abort，不发出网络请求。现场 fixture
覆盖 aborted assistant 的 tool call A 与来自已丢失 assistant 的 orphan result B/C，并断言最终 payload
只保留 `user -> stopped text assistant -> retry user`。其他用例覆盖完整多 tool-call、结果乱序、重复、
孤立、缺失结果以及缺失结果时的纯文本降级。

验证结果：

* `npm run typecheck`：通过；
* Agent 相关 6 个测试文件：37 项全部通过；
* 单 worker 完整 Vitest 第二轮：74 个测试文件、413 项全部通过；
* 首轮全量唯一失败为 Windows 临时目录 `settings.json` 原子 rename 的偶发 `EPERM`，失败文件单独复跑
  17 项全部通过，第二轮全量随后通过；
* 按项目约束未运行 `npm run build`、`npm run dist`，也未启动开发服务器或使用截图替代人工验收。

* [ ] 在当前开发服务器重新加载 main/Worker 改动后，用受影响 Session 执行 Stop -> 重试/继续，确认不再出现 tool/tool_calls 400，并检查新 provider context 中无 orphan tool message。
