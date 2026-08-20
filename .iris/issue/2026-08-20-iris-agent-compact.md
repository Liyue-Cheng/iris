---
title: iris agent compact
status: In Progress
---

## 2026-08-20 现状梳理

### 结论

当前 Iris Agent **没有实际启用 compact**。Pi Coding Agent 0.84.1 本身有自动压缩、手工压缩、
token 估算、摘要消息和 overflow 后 compact-and-retry 等能力，但 Iris 在
`src/main/agent/pi-adapter.ts` 创建 Pi Session 时显式传入了：

```ts
SettingsManager.inMemory({ compaction: { enabled: false } })
```

因此目前所谓的“上下文管理”，准确地说是：

1. 每轮重新组装最新的项目上下文；
2. Iris 自己持久化完整 canonical transcript；
3. Worker 启动或重建时，把仍在当前分支中的 transcript 原样恢复到 Pi 内存；
4. 请求 provider 前修复不合法的 assistant/tool 消息组合；
5. 在网络请求边界捕获、脱敏并保存 provider 实际 payload；
6. 通过 Stop、Continue、Rewind 和 Branch 控制哪些历史继续参与后续请求。

它属于“完整历史恢复 + 合法化投影”，不是“摘要旧历史 + 保留近期原文”的 compact。

### 两套上下文边界

Iris 里其实存在两套不同的上下文链路，不应混在一起讨论：

| 场景 | Iris 负责什么 | 谁负责窗口与 compact |
| --- | --- | --- |
| 外部 CLI 会话 | 入口文件中的静态 Iris 协议、`FOCUS_DOC`、SessionStart 的 `<iris-focus>` 动态快照 | Claude/Codex 等外部 CLI 自己负责对话历史和 compact，Iris 不接管其 transcript |
| 内置 Iris Agent | 显式组装 prompt、持久化 transcript、恢复 Worker、捕获 provider payload | 本应由 Iris/Pi adapter 共同负责，但当前 Pi compact 被关闭，Iris 也没有自己的 compact projection |

内置 Agent 的 Pi ResourceLoader 还显式设置了 `noContextFiles: true`、`noSkills: true` 等选项。
也就是说，它不会再让 Pi 自行扫描 `AGENTS.md` 等上下文文件，而是完全依赖 Iris 的显式组装结果。

### 一轮请求如何形成上下文

当前主链路如下：

```text
最新 software/project/anchor + 用户消息
                  |
                  v
        preparePrompt() 组装输入
                  |
       +----------+-----------+
       |                      |
       v                      v
assembled-input.txt     canonical transcript
                              |
                              v
                   Worker initialize/history
                              |
                              v
                    Pi in-memory SessionManager
                              |
                              v
               normalizeIrisProviderContext()
                              |
                              v
                     provider 实际 payload
                              |
                              v
             脱敏后的 provider-context bundle
```

#### 1. 每轮重新组装最新输入

`src/main/agent/session-manager.ts::preparePrompt()` 每次发送消息时都会重新读取：

- Iris Agent 基础 prompt；
- Iris software protocol；
- 当前项目的 `<iris-project>` 内容；
- 当前 document/workspace anchor；
- 本轮用户消息。

最终组成：

```text
<iris-agent-base>...</iris-agent-base>
<iris-software>...</iris-software>
<iris-project>...</iris-project>
<iris-anchor>...</iris-anchor>
<user-request>...</user-request>
```

这样做的优点是每轮都看到磁盘上的最新项目规则和 anchor，而不是沿用会话启动时的旧快照。
代价是这整块组装输入会作为一条 user frame 写入 transcript，后续每一轮都继续携带。长 issue
正文、software protocol 和 project prompt 会重复占用上下文。

还有一处额外重复：Pi 的真实 system prompt 已经被 ResourceLoader 固定为 `IRIS_AGENT_PROMPT`，
而每轮 user frame 的 `<iris-agent-base>` 又包含同一份基础 prompt。也就是说，当前 provider payload
里基础 Agent 指令既作为 system layer 出现，又在每轮组装输入中重复出现。

#### 2. Iris transcript 是跨 Worker 的真相源

每轮开始前，组装输入先写入 app-owned Session aggregate：

- `turns` 记录 turn 生命周期；
- `timeline` 服务 Renderer 卡片；
- `transcript` 保存真正用于恢复 provider 历史的 user/assistant/tool frame；
- `requestFacts` 保存 prompt 和各层 fingerprint；
- `assembled-input.txt` 保存当轮可读快照。

Session store 通过 journal 持久化 aggregate。Worker 是可丢弃的执行资源，Iris 的 transcript 才是
跨进程退出、app 重启、模型切换和 Worker idle shutdown 后的 canonical history。

#### 3. Worker 启动时恢复全部保留历史

Worker 是 lazy start。`AgentWorkerHost` 启动时从 store 读取 `AgentHistorySnapshot`，其中包含：

- 当前 session revision；
- anchor；
- 所有未被 Rewind 移除的 turn 对应的 transcript frame。

`restoreIrisPiHistory()` 按顺序把这些 frame append 到 Pi 的 in-memory `SessionManager`。ready 握手会
校验 revision、消息数和 history digest，避免 Worker 在旧历史上继续执行。

这里没有 token budget、最近 N 轮、按字符裁剪或摘要替换。只要 turn 仍在当前分支上，它的 provider
frame 就会继续恢复。

#### 4. 请求前做的是合法化，不是压缩

`normalizeIrisProviderContext()` 在每次 `ModelRuntime.streamSimple()` 前处理消息序列：

- aborted assistant 只保留 provider-safe 的可见文本；
- assistant tool calls 与紧随其后的 tool results 作为原子组校验；
- 缺失、重复、孤立或错位的 tool result 被删除；
- 不完整的 tool-call assistant 若有文本，则降级为纯文本 assistant；
- standalone orphan tool result 不进入 provider 请求。

这一步解决 provider 协议合法性和 Stop/Continue 恢复问题，但不会减少正常、完整历史的体积。

#### 5. 保存的是 provider 最终上下文证据

adapter 在 provider `onPayload` 边界捕获转换后的真实请求，经过 allowlist 和 known-secret 脱敏后，
按 turn 保存 `call-NNN.json`、`call-NNN.txt` 和 `index.json`。工具循环产生的多次 provider 调用会
依次追加。

context bundle 当前明确写着：

```json
{
  "contextStage": "provider-payload",
  "compaction": "disabled"
}
```

因此 `assembled-input` 是 Iris 组装阶段的诊断材料，provider-context bundle 才是模型实际看到内容
的证据。两者都不是 compact summary。

### 哪些历史会被保留或排除

- 正常完成的 turn：user、assistant、tool call/result 的 provider frame 都保留。
- Stop/失败：UI 中未完成 reply 会标记为 stopped/failed 或 excluded；只有已经形成 provider-safe
  canonical frame 的部分才会进入重建历史，错误展示本身不会伪装成对话消息。
- Continue：先关闭旧 Worker，再从 canonical history 重建新 Worker，清理尾部未提交 assistant 后，
  对同一个 paused turn 调用 Pi `continue()`。
- 在 paused session 中直接发新消息：旧 turn 变为 abandoned，再开始一个新 turn。
- Rewind：只把最近 turn 标记为 `removed`，history snapshot 会过滤它；文件和终端等外部副作用不回滚。
- Branch：复制指定 completed turn 及之前的完整 transcript 到新 session。它改变分支，不会自动缩短
  分支点之前的上下文。

这里的 `contextDisposition` 主要表达卡片/回复是否应被视为已提交上下文；真正重建 Worker 时读取的
仍然是 canonical `transcript`，不是 Renderer timeline。

### 当前 token 和 overflow 行为

目前没有 Iris 自己的全局 token 账本、窗口水位或主动 compact 阈值。自定义 provider 找不到上游模型
元数据时，会使用 `contextWindow: 128000` 和 `maxTokens: 16384` 作为模型 metadata，但这不是 Iris
对 transcript 的裁剪策略。

Pi 上游默认 compact 参数原本是：

- `reserveTokens: 16384`；
- `keepRecentTokens: 20000`；
- 超过 `contextWindow - reserveTokens` 时触发 threshold compact；
- context overflow 时尝试 compact-and-retry 一次。

这些逻辑因为 `enabled: false` 全部不会执行。上下文超过 provider 能力时，当前请求会作为 provider/
runtime failure 暂停；Iris 不会自动生成 summary，也不会自动缩短历史后重试。若历史本身已经过大，
单纯点击 Continue 或追加新消息通常不能解决，因为 Worker 会再次恢复同一份完整历史。

### 我的判断

现有设计已经把几个重要边界做对了：Iris 拥有 canonical history，Worker 可重建；UI timeline 与
provider history 分离；provider 最终 payload 可审计；不合法的 tool 序列会在网络前被修复。

真正缺失的是一个 **app-owned、可持久化、可审计的 active-context projection**。理想语义应当是：

```text
完整原始历史（永久保留，供审计/分支/查看）
                  |
                  v
compact boundary + summary + 最近若干完整 turn
                  |
                  v
       Worker / provider 的 active context
```

不能只把 Pi 的 `enabled` 改成 `true`。目前 Pi SessionManager 是从 Iris transcript 临时重建的内存对象；
即使某个 Worker 内成功 compact，Iris aggregate 也没有 compaction entry、summary、boundary、token usage
或对应 journal transaction。Worker 一旦退出，下一次仍会从未压缩 transcript 全量恢复，compact 结果
随即丢失，context artifact 也无法准确解释这次变换。

所以后续 compact 的核心不是“调用一个摘要 API”，而是先定义 Iris 自己的 durable context projection：
原始历史不删除，压缩边界和摘要成为有版本的领域事实；Worker 初始化读取 active projection；Rewind、
Branch、Stop/Continue、模型切换和 provider-context artifact 都明确理解同一套边界。Pi 的算法可以复用，
但所有权和持久化语义必须留在 Iris。

## 2026-08-20 Compact 方案设计

### 设计结论

推荐把 compact 做成 Iris Session 的一等领域能力，而不是把 Pi 的 `compaction.enabled` 改为
`true`。总体结构是：

```text
canonical history（完整、不可丢、用于审计和重新分支）
                            |
                            v
              Iris context projection
       latest summary + retained complete turns
                            |
                            v
                  Worker / provider payload
```

这里有四条硬约束：

1. compact 永远不删除 `turns`、`timeline`、`transcript`、effects 或 provider artifacts；
2. summary 不是 canonical history，只是有来源、有边界、有版本的派生投影；
3. 压缩边界只落在完整 turn 之间，不拆 assistant/tool-call/tool-result 原子组；
4. summary 生成成功并持久化之前，active projection 不发生变化。

Pi 可以继续提供 token 估算、cut-point 和 summary prompt 等纯算法，但压缩记录、active pointer、事务、
恢复和 UI 都由 Iris 拥有。Pi 内建的自动 compact 仍保持关闭，避免出现两套互不知情的压缩状态。

### 先解决每轮上下文重复

compact 不能替代输入去重。当前每条历史 user frame 都包含完整的 agent/software/project/anchor，最近保留
的若干 turn 仍会重复这些大块内容，而且 `IRIS_AGENT_PROMPT` 同时出现在 system prompt 和
`<iris-agent-base>` 中。

推荐把 active context 明确拆成：

```text
system: IRIS_AGENT_PROMPT（只出现一次）
current envelope: 最新 software + project + anchor（当前请求只出现一次）
historical summary: 可选
retained history: 历史 user 原始请求 + assistant/tool 原文
current user request
```

canonical user 输入应以 Renderer 中已有的原始 user activity 为准；`assembled-input.txt` 继续保存当轮完整
组装快照。恢复历史时，已完成旧 turn 使用原始 user request，不再恢复旧的 assembled prompt；当前正在
执行或 Continue 的 turn 仍使用它当时持久化的 assembled input。旧 session 不需要解析 XML，可按
`turnId` 从 `timeline` 找回原始 user 内容。

这项去重应当先于自动 compact 落地，否则 token 水位和 compact 效果会被重复协议文本污染。

### 领域模型

在 `AgentSessionAggregate` 中增加 `compactions` 和 `activeCompactionId`。建议记录如下信息：

```ts
interface AgentCompaction {
  id: string;
  state: 'running' | 'completed' | 'failed' | 'canceled';
  trigger: 'manual' | 'threshold' | 'overflow';
  sourceCompactionId?: string;
  sourceRevision: number;
  sourceDigest: string;
  coveredThroughTurnId: string;
  firstRetainedTurnId: string;
  summary?: string;
  summarySha256?: string;
  model: IrisAgentModelRef;
  promptVersion: number;
  tokensBefore: number;
  estimatedTokensAfter?: number;
  measurement: 'reported' | 'estimated';
  providerUsage?: AgentUsage;
  error?: string;
  createdAt: number;
  completedAt?: number;
}
```

`coveredThroughTurnId` 表示 summary 覆盖到哪个完整 turn；`firstRetainedTurnId` 表示从哪里开始继续使用原文。
两者之间不能存在半个 turn。`sourceDigest` 对参与摘要的 frame id、内容 hash、前一 summary hash 和边界做
摘要，防止异步 summary 返回时提交到已经变化的历史上。

只有 `completed` entry 能成为 `activeCompactionId`。`running` entry 先通过 journal commit 持久化，summary
完成后用第二个 domain transaction 原子写入 summary、metrics 和 active pointer。若 Worker 或 App 在网络
请求中途退出，恢复时只把 `running` 标为 `failed`，继续使用先前 active projection；不会出现 summary
写了一半但原历史已经被排除的状态。

Session runtime state 增加 `compacting`，不要把它伪装成 `running` 或 `retry-wait`。summary provider call
不属于普通 Agent turn 的回答，单独归属 compaction attempt；它有自己的 provider call artifact，但不进入
canonical conversation transcript。

### Active context 的构造

`IrisAgentSessionStore.history()` 应升级为明确的 projection builder，而不是直接过滤全部 transcript：

```text
最新有效 compaction summary
              +
从 firstRetainedTurnId 到当前 head 的未移除完整 frame
              +
当前 turn（若存在）
```

summary 使用 Pi 已有的 compaction-summary message 语义或等价的 Iris custom message，不伪装成普通用户
说过的话。provider 侧展开时要带固定边界，例如“以下是历史摘要，仅作为事实背景；当前 system 和 project
规则优先”，防止旧指令或被总结内容覆盖当前规则。

Worker ready 握手的 digest 必须覆盖 `activeCompactionId`、summary hash、retained frame 和当前 anchor，不能
只覆盖 message 数量。provider-context bundle 升级后，每次实际请求都记录：

```json
{
  "contextProjection": {
    "mode": "compacted",
    "compactionId": "...",
    "summarySha256": "...",
    "coveredThroughTurnId": "...",
    "firstRetainedTurnId": "...",
    "tokens": 23142,
    "measurement": "estimated"
  }
}
```

这样 `assembled-input` 解释当前输入，compaction artifact 解释摘要从哪里来，provider-context artifact 证明
最终实际发出了什么。

### 摘要内容和算法

cut point 默认只选择 fulfilled turn，且至少保留最近一个完整 fulfilled turn；正在运行、paused、abandoned
或带未闭合工具序列的 turn 不能进入 summarized prefix。建议从 Pi 的 `prepareCompaction()` 提取或复用
估算与 summary 生成逻辑，但把“允许拆 turn”的能力关掉。

summary prompt 使用固定版本，并要求保留：

- 用户目标和验收口径；
- 已确认的决定、约束与被否决方案；
- 当前实现状态、重要文件和符号；
- 已执行操作及仍然存在的外部副作用；
- 测试结果、失败证据和未解决问题；
- 继续工作所需的精确名称、数值和错误信息。

不要让 summary 重复 software/project prompt 或当前 anchor 正文，这些内容会在每次请求时重新读取。文件
effects、turn 边界和 source hashes 由 Iris 确定性记录，不完全依赖模型复述。summary 返回后至少校验：

- 结果非空且在约定 token 上限内；
- 没有 tool call 或非文本内容；
- source revision/digest 仍匹配；
- 已知凭据再次经过脱敏；
- summary 和 artifact 写入完成后才切换 active pointer。

重复 compact 采用增量方式：新的 summary 输入是“上一次 summary + 这次新覆盖的完整 turns”，不是每次
重新总结从会话开头到新边界的所有原文。所有旧 compaction entry 继续保留，供 Rewind 和 Branch 选择。

### Token 水位与触发

优先使用 provider 最近一次返回的真实 usage，再估算其后的新增 frame；没有可靠 usage 时使用 Pi 的保守
估算，并在 UI 标为“估算”。不要把自定义 provider 的 `128000` fallback 当作已确认事实；模型窗口元数据
不可信时可以显示估算值并允许手工 compact，但 threshold 自动触发应更保守，实际 overflow 仍可触发恢复。

默认策略可沿用 Pi 的基准值并按小窗口动态收缩：

```text
reserveTokens = min(model.maxTokens, 16384) + safetyMargin
trigger        = contextWindow - reserveTokens
keepRecent     = min(20000, 50% of trigger)
```

不建议第一版暴露 reserve/keepRecent 的高级设置。先提供默认自动 compact 和“立即整理上下文”命令，等真实
usage 数据足够后再决定是否需要用户配置。

触发分三类：

1. `threshold`：发送新请求前预检 active projection 加本轮输入；达到水位时先 compact，再发业务请求；
2. `overflow`：provider 明确拒绝上下文后，在同一 turn 中 compact 并自动重试一次；
3. `manual`：session 静止时由用户主动触发，不创建伪 user turn。

不建议在一个正常回答刚结束后后台发起 summary 请求。那会产生用户没有预期的额外费用和网络活动。回答
结束时只更新水位；在下一次请求前执行 threshold compact，更容易理解和取消。

### 执行状态机

正常 threshold 流程：

```text
用户发送消息
    |
记录 turn 和 assembled input
    |
preflight 命中水位
    |
commit running compaction -> session.compacting
    |
Worker 生成 summary，Main 校验 sourceDigest
    |
commit completed compaction + active pointer
    |
重建 Worker 并校验 projection digest
    |
发送原业务请求
```

overflow 恢复流程：

```text
provider context overflow
    |
当前 attempt failed，但 turn 保持可恢复
    |
按 overflow trigger compact
    |
成功 -> 从新 projection 重建 Worker -> 同一 turn 自动重试一次
    |
再次 overflow -> pause，不循环 compact/retry
```

Stop 在 compact 阶段应 abort summary provider call。手工 compact 被 Stop 后回到原 idle 状态；为某个业务
turn 做的自动 compact 被 Stop 后，该 turn 进入 paused，旧 active projection 保持有效。

### Continue、Rewind、Branch 和模型切换

#### Continue

普通 provider/network pause 继续沿用当前 projection。`context-overflow` 或 `compaction-failed` pause 不能
再让“继续”原样重发超标 payload；它应当重新尝试 compact，或在用户换到更大窗口模型后重新做 preflight。
因此 pause reason 需要增加结构化的 `context-overflow` 和 `compaction-failed`，而不是都映射为 `runtime`。

#### Rewind

Rewind 仍只移除 turn，不回滚外部副作用。若移除的是 active boundary 之后的 retained turn，当前 summary
仍有效；若连续 Rewind 越过 `coveredThroughTurnId`，则回退到边界更早的 completed compaction，找不到时
回退到 full history。active pointer 的回退与 turn removal 在同一个 journal transaction 中提交。

#### Branch

从 turn `T` 分支时，选择 `coveredThroughTurnId <= T` 的最新 completed compaction。若存在，则把 summary
字段自包含地复制到新 session，并记录 `originCompactionId`；不能跨 session 依赖父 session 的 artifact。
若所有 summary 都覆盖了 `T` 之后的历史，则新分支从 canonical prefix 构建 full projection。分支创建后，
父子 session 的 compaction 独立演进。

#### 模型切换

summary 内容应保持 provider-neutral，可以在模型切换后继续使用。切到更小窗口模型时重新计算水位，必要时
再次 compact；切到更大窗口模型时不自动“解压”旧 summary，因为这会悄悄改变模型看到的历史语义。完整
原文仍在，未来可以另做“从完整历史重建上下文”的显式命令，但不属于第一版。

### 展示设计

展示目标不是反复提醒用户“系统在压缩”，而是让用户随时知道三件事：当前水位、是否正在处理、哪些旧
内容已经不再逐字发送。

#### 1. 顶部 Context 指示器

在模型选择器附近增加一个稳定尺寸的 Context 图标按钮和简短水位，不新增常驻卡片：

```text
[模型选择器]   [Context 68%]   [撤销]
```

- 正常水位使用中性色；接近阈值使用 amber；不要用红色表达尚未发生的错误；
- tooltip 显示 `87k / 128k（估算）` 或 `87k / 128k（provider 报告）`；
- 点击 popover 展示 active context 的组成：当前规则、summary、保留原文 turns、预留输出；
- popover 提供“立即整理上下文”和“查看最近摘要”，阈值参数不放在这里；
- 窄窗口只保留图标和百分比，文本不得挤压模型选择器。

#### 2. Compact 进行中

summary 请求期间，session 状态显示“整理上下文”，输入暂时不可再次提交，并提供 Stop。threshold 场景用
一条紧凑状态栏：

```text
正在整理上下文…                                      [停止]
```

overflow 恢复时改为：

```text
上下文已满，正在整理并重试…                          [停止]
```

不要先展示 provider overflow 红色错误再立刻自动恢复；只有恢复最终失败时才进入错误状态。

#### 3. Timeline 压缩边界

压缩成功后，在 `coveredThroughTurnId` 和 `firstRetainedTurnId` 之间插入一条非卡片式 divider：

```text
────────  已整理 18 轮 · 96k -> 22k  [展开]  ────────
```

timeline 的历史原文仍然可查看，不删除、不改写，也不需要给每张旧卡片加重复 badge。展开 divider 后显示：

- summary 原文；
- 覆盖的 turn 范围；
- trigger、时间、生成模型；
- 压缩前 token 与预计压缩后 token；
- “这些轮次仍保存在 Iris，但不会逐字发送给模型”的状态说明；
- provider/source artifact 的现有打开入口。

多次 compact 只让最新 active boundary 默认展开入口，旧 divider 仍随历史存在并可检查。自动成功不弹 modal；
状态栏消失并在 timeline 留下 divider 即可。

#### 4. 最终失败

自动 compact 失败时保留原历史和旧 projection，并显示面向动作的错误：

```text
上下文已超出当前模型上限，自动整理失败。
[重试整理] [切换模型] [展开技术详情]
```

若 summary 已成功但业务请求重试后仍 overflow，则明确说明已经自动重试过一次，不再循环。此时普通“继续”
不应存在，以免制造必然失败的相同请求。技术详情中保留 provider 原始错误，主文案不直接暴露一长串错误。

### Artifact 与审计

每个 compaction 建议拥有独立目录：

```text
artifacts/compactions/<hash>/
  source-index.json
  summary.txt
  provider-context/
    call-000.json
    call-000.txt
    index.json
```

`source-index.json` 只记录 frame id、turn 边界、hash、前一 compaction id 和 prompt version，不重复保存一份
可能含敏感信息的完整 transcript。`summary.txt` 保存实际进入 future context 的脱敏后文本。summary provider
payload 与普通 provider context 使用同一 allowlist 和 secret redaction。

### 实施顺序

- [ ] 先把 historical user request 与每轮 assembled envelope 分离，移除重复的 `<iris-agent-base>`。
- [ ] 增加 compaction domain model、journal transaction、恢复校验和 active projection builder。
- [ ] 扩展 Worker 协议，实现可取消的 summary 调用、source digest 校验和 projection ready digest。
- [ ] 增加 compaction artifacts，并把普通 provider-context bundle 升级为可解释 projection 的 schema。
- [ ] 实现 manual 和 threshold compact，再实现 overflow 后同 turn 自动重试一次。
- [ ] 补齐 Continue、Rewind、Branch、模型切换和 restart 的边界语义。
- [ ] 增加 Context 指示器、compacting 状态栏、timeline divider 和失败恢复操作。

### 验收项

- [ ] compact 后关闭 Worker、重启 App、切换模型，恢复出的 active context digest 保持一致。
- [ ] compact 前后的完整 timeline、canonical transcript、effects 和原 provider artifacts 均未丢失。
- [ ] provider 实际 payload 只包含一个最新规则 envelope、一个最新 summary 和 retained turns。
- [ ] cut point 不会拆开 user/assistant/tool-call/tool-result，也不会覆盖正在运行或 paused turn。
- [ ] overflow 自动 compact 成功后在同一 turn 重试且最多一次，不产生第二条 user activity。
- [ ] summary 请求失败、被 Stop、Worker crash 或 journal 尾部损坏时，旧 projection 仍可恢复。
- [ ] Rewind 跨过 compact boundary 时会回退到更早 projection 或 full history，不携带已移除 turn 的摘要。
- [ ] Branch 在边界前后都只看到分支点之前的事实，并且不依赖父 session artifact。
- [ ] UI 能区分 provider 报告和估算 token；窄窗口下 Context 控件、模型选择器和操作按钮不重叠。
- [ ] context artifacts 能从任意 provider call 追溯到 compaction id、summary hash 和 retained boundary。
