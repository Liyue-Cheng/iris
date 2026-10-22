---
title: agent开发探讨
---
我们现在真打算开发自己的Agent，替代codex claude code这些垃圾

我先来说说有什么问题：

首先是codex

1：没有rewind功能，这实在是太离谱了

2：沙箱经常导致命令执行结果出现静默变化，导致agent走错路

3：长程任务的建模非常糟糕，agent需要通过命令行循环等待，这说得过去吗？

<br />

然后是claude code

1：长程任务的建模同样是极差的，命令等待和通知功能混在一起

2：过于封闭

3：子agents几乎就纯添乱

4：和第三方模型的兼容性过差

5：过于注重互联网的权限礼仪

6：session hook的限制过大

<br />

然后是opencode，听说代码混乱，有很多bug！然后同样是过于庞大，我认为这都是非本质的

<br />

谈谈你对这些问题的理解

codex确实写了一些长程任务功能，但是现在模型还在轮询，完全没有用好这些功能

输出存在 10,000 字符限制已经是不可接受的严重问题了

<br />

然后我又想到了一些新的问题：

两边都受到TUI的严重限制，但是将TUI搬到GUI之后，交互还是垃圾一样，甚至比TUI给的信息还少，还难以操作，还混乱，gui要我说，做的还没有cursor好

claude code的提示词过于庞大

<br />

然后是长程任务，我现在还想到了一些其他的问题——agent运行一个长vivado仿真任务，然后我看不到进度！我看不到终端，有很多时候，就是我甚至都不知道AI的分析有没有道理

然后是可观测性和垃圾一样原始提示词看不到（这本来应该是gui的重要功能），很多时候模型不停的 error writing file，但是我都不知道原因！

<br />

## 对这些问题的整理与理解

这些问题表面上分属于 rewind、沙箱、长程任务、子 agent、hook、模型兼容和 GUI，但它们实际上指向同一个根本缺陷：现有 coding agent 仍然以“对话循环加工具调用”为核心，任务状态、进程状态、权限状态和工作区状态都只是后来附加在对话上的功能。短任务中这套模型尚且可用，一旦任务持续几个小时、包含多个并行进程、经历上下文压缩或需要用户中途介入，整个抽象就开始失效。

### 1. Rewind 不只是撤回一条消息

Codex 现在已经有会话分支和编辑旧提示后创建分支的能力，但这仍然不等于完整的 rewind。真正有用的 rewind 至少需要分别记录：

* 对话与模型上下文的时间线；

* 文件系统和代码修改的时间线；

* 进程、权限和其他运行时状态；

* 已经发生的外部副作用。

文件修改可以通过快照或补丁恢复，对话可以通过分支恢复，但部署、数据库写入、网络请求等外部副作用未必可逆。因此系统不能把 rewind 做成一个虚假的“全部恢复”按钮，而应明确区分可直接回滚、需要补偿操作和不可逆的事件。

Claude Code 的 checkpoint 比 Codex 更接近用户需要的工作流，但仍没有从根本上解决外部副作用和运行时状态的问题。我们自己的 agent 应当从一开始就采用事件溯源和显式分支，而不是把聊天记录当作唯一真相。

### 2. 沙箱最危险的问题是静默改变事实

沙箱本身不是问题，真正不可接受的是 agent 请求执行命令 A，系统实际执行了经过代理、降级或重写的 A'，但界面和工具结果没有明确说明这种变化。此时模型会基于一个错误的世界模型继续行动。

每次执行都应该明确保存并展示：原始命令、实际命令、工作目录、关键环境变量、文件系统权限、网络权限、审批结果、退出状态、stdout、stderr，以及输出是否被截断或过滤。任何沙箱降级、代理行为和权限替换都必须成为结构化事件，不能藏在日志里，更不能静默发生。

### 3. 有长程任务工具，不等于真正支持长程任务

Codex 已经有后台终端、goal、通知等功能，但模型仍然频繁使用命令行轮询。这说明能力虽然存在，却没有进入模型的默认行动路径，运行时也没有真正接管调度。

合理的长程任务模型应该是：agent 启动任务并获得稳定的 task handle，声明自己等待的完成、失败、进度或超时事件，然后结束当前调度片并释放模型。任务产生事件后，调度器恢复原来的 agent run，并注入结构化状态。等待不应该表现为模型反复调用 sleep、wait 或查询终端。

Claude Code 将后台任务完成通知混入后续对话 turn，也存在类似问题。通知、命令输出和用户消息不是同一种东西，不应共享一条含糊的消息通道。长程任务需要持久 scheduler、事件订阅和明确的生命周期，而不是让模型在 transcript 中自行模拟调度器。

### 4. 完整终端必须是用户拥有的一等对象

现有 GUI 最愚蠢的问题之一，是 agent 明明正在替用户操作终端，用户却看不到这个终端的完整信息。界面往往只展示一张工具卡片、几行摘要或一个“Command running”状态。真实 stdout、stderr、完整 scrollback、当前进程以及失败原因都被隐藏了。

这会形成两层不透明解释：真实终端输出先被 agent 理解一次，agent 的行为又被 GUI 摘要一次。一旦 agent 判断错误，用户甚至无法检查它为什么错。例如模型不断报告 `error writing file`，但目标路径、系统错误、权限拒绝和沙箱原因不可见，用户只能继续询问已经误判的模型。

Agent 使用的终端必须同时是用户可以完整观察和接管的终端。它至少应具有：

* PTY 和持久化的完整原始输出；

* stdout、stderr 的真实顺序和完整 scrollback；

* 实际命令、工作目录、环境和 sandbox provenance；

* 当前进程树、运行时间和退出状态；

* 搜索、复制、attach、detach、输入、终止和人工接管能力；

* 明确标记模型实际读取了哪些区段、哪些内容被裁剪。

摘要和进度提取可以叠加在完整终端之上，但绝不能替代完整终端。即使 Vivado 这类任务的日志不能准确表达进度，用户也必须先拥有查看全部日志的基本能力。

### 5. 10,000 字符限制暴露了错误的数据模型

任何 IPC 和上下文通道都需要资源上限，但把 hook 的有效输出限制为一个 10,000 字符字符串，并把超出部分降级成文件路径，是不可接受的设计。关键错误可能位于被截断部分，模型也未必会主动读取文件，于是截断会直接改变判断结果。

大输出不应该作为无限字符串注入，而应该成为一等 artifact。Hook 返回值应包含结构化 decision、摘要、artifact 标识、媒体类型、大小、完整性和是否必须消费等字段。对于 required artifact，运行时必须保证模型读取或显式拒绝，不能依赖模型偶然决定是否打开某个文件。

### 6. TUI 的信息架构被错误地搬进了 GUI

问题不只是 TUI 空间有限，而是整个产品仍然以纵向聊天时间线组织信息。真实工程任务包含目标、子任务、终端、进程、文件 diff、测试结果、权限请求、agent 分支、失败重试和用户决策等并列对象。把这些内容全部压进一条聊天流，本来就无法清楚表达状态。

很多 GUI 只是把工具调用包装成卡片并增加折叠，结果反而比 TUI 信息更少、操作更慢。Cursor 相对好用，不只是因为视觉设计，而是编辑器原本就拥有文件、diff、diagnostic、terminal 和 source control 等稳定对象，AI 没有垄断用户访问这些对象的入口。

我们自己的 GUI 不应是“聊天窗口加强版”，而应更接近任务控制台和 run debugger。聊天只用于提交意图、讨论和消除歧义；终端、artifact、diff、任务树、事件时间线和权限决策都应有独立、稳定、可直接操作的视图。

### 7. 原始上下文必须可观察

现有产品不仅隐藏终端输出，也隐藏模型实际收到的输入。用户通常看不到最终 system prompt、项目指令、skills、hook 注入、上下文压缩结果、被裁剪的历史以及工具 schema。于是输入端和输出端都不可审计。

GUI 本应提供一个 context inspector：展示本次调用使用了哪些上下文块、来源是什么、优先级如何、占用了多少 token、哪些内容被截断或压缩，以及模型最终可见的消息序列。敏感信息可以按权限脱敏，但不能用“界面简洁”作为整体隐藏的理由。

### 8. Claude Code 的巨大提示词是在用自然语言模拟运行时

大提示词本身不是原罪，问题是大量本应由确定性程序负责的规则被写进了提示词，例如权限礼仪、工具选择、Git 保护、子 agent 规则、结束条件和异常补丁。这样会导致确定性约束变成模型尽量遵守的建议，规则之间难以证明优先级，换一个模型就需要重新验证整套隐含行为，产品 bug 也容易通过继续堆提示词来修复。

如果违反一条规则会造成系统性错误，并且机器能够客观判断是否违反，那么它就不应该只存在于提示词中。权限应由 policy engine 执行，生命周期应由状态机执行，格式应由 schema 验证，Git 保护应由 transaction/checkpoint 层保证，状态恢复应由 event store 完成。模型只负责无法被确定性程序替代的理解和判断。

### 9. 子 agent 的问题主要是缺少可靠的协作协议

子 agent 并非天然无用，但现有产品经常在任务边界不清、上下文不完整、共享工作区无隔离的情况下主动拆分任务。由此产生额外上下文成本、工作区冲突、权限继承错误和结果难以验证等问题，最终经常纯粹添乱。

子 agent 只应处理边界清楚、结果可验证的任务。默认应只读或使用隔离工作区，并通过明确 contract 接收输入、声明允许的工具和权限、返回结构化 artifact。父 agent 必须能够知道子任务使用了什么上下文、修改了什么、验证了什么，而不是只收到一段自然语言总结。

### 10. Provider-neutral 不能只做到 API 形状兼容

Claude Code 对 Bedrock、Vertex、Foundry 和网关有支持，但核心仍围绕 Claude 的消息、thinking、tool use 和模型命名语义设计。OpenAI-compatible 也只代表 HTTP 接口大致相似，不代表 reasoning、tool call ID、并行调用、流式错误、上下文缓存和压缩语义一致。

真正的多模型 runtime 需要一个规范化的中间表示，并明确记录每次 provider 转换是否有损。不能假装所有模型都有相同能力；调度器应根据 capability 选择行为，界面也应能说明某项能力为什么在当前 provider 上降级。

### 11. OpenCode 的问题更像产品面过宽，而非已经证明代码必然混乱

OpenCode 的 provider、TUI、桌面端、Web、服务端、插件、权限、压缩和 subagent 同时演进，组合状态非常庞大，公开 issue 中也确实能看到 provider 回归、上下文压缩丢失、嵌套权限挂起和进程崩溃等问题。但仅凭 issue 数量不能证明代码质量差，Codex 和 Claude Code 同样有大量问题。

更可靠的判断是：OpenCode 已经承担了过大的产品表面积，因此很容易在各层交界处产生状态爆炸。它适合作为 provider 适配、客户端/服务端分离和开放扩展的参考实现，但不应不加选择地作为自研内核的基础。

## 对自研 Agent 的结论

真正值得开发的不是另一个终端聊天工具，也不是重新复制 Codex 或 Claude Code 的全部功能，而是一个更小、更可靠的 agent kernel：

* 使用事件溯源保存持久 run，而不是以 transcript 作为唯一状态；

* 分别建模对话分支、文件快照、进程状态和外部副作用；

* 以 scheduler、task handle、subscription 和 wake event 支持长程任务；

* 将终端、artifact、diff 和任务作为一等对象，同时供用户和 agent 使用；

* 完整记录工具执行的环境、权限、沙箱变化和输出 provenance；

* 使用 capability policy，而不是让模型通过自然语言反复申请权限；

* 使用带版本和身份信息的 typed event bus，而不是混杂的通知字符串；

* 使用 provider 中间表示和明确的有损转换记录；

* 让子 agent 通过可验证 contract 协作，并默认隔离；

* 提供完整终端、context inspector、事件时间线和 artifact 查看器；

* 将确定性规则从提示词移入运行时，只让模型负责语义理解和判断。

这些产品共同缺少的不是某个漂亮功能，而是状态可信、过程可见、任务可等待、错误可解释、操作可接管。自研 agent 的竞争力也应该来自这些基础能力，而不是来自更多卡片、更多 slash command 或更大的 system prompt。

## 当前设计决策

下面是经过进一步讨论后确定的设计边界。它们覆盖前文中关于通用异步调度、子 agent、安全策略和扩大 rewind 范围的建议；后续设计以本节为准。

### 1. 单个分支严格同步，不支持 Agent 自主异步

很多长程任务并不只是“需要等待”，而是存在明确的因果限制。例如修改代码、运行 Vivado、根据结果继续修改，这三步必须顺序发生。终端任务没有结束时，后续推理缺少成立的前提。因此单个分支中始终只有一条同步因果链，Agent 不会在等待期间自行切换到其他任务，也不建立通用后台任务图、scheduler 或自动异步编排。

长命令被视为同一次尚未完成的前台工具调用。工具调用结束以前，当前分支不会继续执行依赖其结果的后续步骤。

如果用户希望同时处理另一件事，应当显式点击分支按钮，切换到新分支继续工作。并发由用户主动创建，并以分支形式清楚呈现，而不是由 Agent 在后台隐式制造。原来的终端任务始终属于原分支，不会迁移到新分支。

### 2. 长命令由模型每 20 秒轮询一次

长命令执行期间，模型每 20 秒读取一次终端新增输出并判断运行是否正常。这个轮询是尚未完成的工具调用内部的临时观察，不是新的用户/助手轮次。

- 如果输出正常，观察结果立即丢弃，不写入会话历史，也不进入后续主上下文；
- 如果终端没有新增输出，可以不调用模型，继续保持工具调用运行；
- 如果模型发现可疑情况，应暂停正常监督，向用户说明依据并请求是否终止；
- 除非用户明确授权，不因为一条可疑日志擅自终止任务；
- 终端任务结束后，工具调用才完成，并将最终结果交回当前会话继续推理。

“不进入上下文”指正常轮询不会累计到主会话历史中，并不意味着轮询推理本身没有临时输入或模型调用成本。每次观察只需要读取终端增量和必要的少量运行状态；完整终端记录独立保存。

这套机制不需要事件订阅或复杂调度器。固定轮询虽然简单，却适用于 Vivado、编译器、测试工具和其他没有统一事件协议的 CLI，也忠实表达了当前步骤对命令结果的因果依赖。

### 3. 直接复用 Iris 已有终端

Iris 已经具备终端，不需要再设计单独的“Agent 长任务面板”。终端展示规则保持简单：

- 3 秒内结束的命令只记录命令和结果，不主动展示终端；
- 超过 3 秒仍未结束的命令，终端自动变为可见；
- 终端可见时展示的是同一个真实终端从启动开始的完整信息，而不是从第 3 秒才开始截取；
- 用户能够直接查看完整输出和任务当前状态；
- 命令完成后，终端记录仍然可以回看。

3 秒只是界面展示边界，不是任务调度边界。模型的 20 秒轮询与用户看到的终端来自同一个终端事实源：用户查看完整实时记录，模型读取新增输出，会话历史只接收异常决策和最终结果。

如果命令在 3 秒内就需要交互输入，终端应立即显示。无论是否自动展示，原始终端信息都不能因为 GUI 摘要而丢失。

### 4. 完整终端优先于摘要

Agent 正在使用的终端必须同时对用户完整可见，不能只提供工具卡片、几行摘要或“Command running”。用户应能直接看到真实命令、工作目录、完整 stdout/stderr、scrollback、运行状态、退出码和实际错误原因。

摘要可以作为辅助信息，但不能替代原始事实。模型发生误判时，用户必须能够绕过模型的解释，直接检查终端为什么失败。尤其不能出现模型反复报告 `error writing file`，用户却看不到目标路径、系统错误和命令原始输出的情况。

### 5. 不设置子 Agent

Iris Agent 不提供子 agent，也不让模型自行拆分、委派或并发执行任务。子 agent 会引入上下文分配、工作区冲突、权限继承、结果验证和额外模型调用等复杂性，而这些复杂性对于当前产品目标没有必要。

需要并行工作时，由用户手动创建分支。手动分支已经提供需要的并发能力，并且每条因果链都对用户可见。系统不再额外设计 delegation prompt、父子 agent 协议、子 agent 工作区隔离或结果汇总机制。

### 6. 不做安全系统

Iris Agent 不做沙箱、网络访问限制、普通命令逐项审批或权限礼仪。Agent 继承启动 Iris 的用户权限，并以这些权限直接执行命令。系统不承诺抵御恶意仓库、恶意依赖、prompt injection 或不可信代码。

这一选择的目的不是宣称操作没有风险，而是避免安全层静默改变命令语义，导致模型以为执行了某个操作，实际运行的却是被代理、拒绝或降级的另一个操作。

不做安全不等于不做可观测性。实际命令、终端输出、文件修改和错误原因仍然必须完整可见。这里依靠的是明确的信任边界和用户监督，而不是沙箱与反复审批。

### 7. Rewind 与 Claude Code 一样，只回退工具修改的代码

Rewind 只负责恢复 Agent 通过受管文件工具产生的代码修改，并恢复到所选历史节点对应的会话状态。它不尝试回退终端命令、正在运行的进程、网络请求、数据库写入、部署、远端 Git 操作或任何其他外部副作用。

这个边界应在界面中明确表达，不能暗示系统能够让整个外部世界回到过去。Rewind 的承诺只有两部分：

- 回到所选节点继续对话或创建相应分支；
- 撤销该节点之后由受管编辑工具记录的代码修改。

通过终端脚本、formatter、codegen 或其他外部程序产生的文件变化，不属于工具修改的代码，原则上不在 rewind 保证范围内。第一版不为此引入全工作区快照、外部副作用追踪或补偿事务。

### 8. GUI 必须展示模型实际看到的上下文

GUI 的重要职责之一是可观测性。除了完整终端，还应允许用户检查模型实际收到的原始上下文，包括 system prompt、项目指令、注入内容、工具定义、会话历史、压缩结果以及发生的裁剪。

用户不能只看到自己输入的消息和模型输出的结论，却看不到模型赖以判断的真实输入。摘要和简化视图可以默认存在，但完整信息必须能够直接展开检查。

### 9. 避免用巨大提示词模拟确定性机制

提示词用于帮助模型理解用户意图和完成语义判断，不应承载大量本可以由程序直接确定的产品行为。轮询周期、终端显示阈值、历史写入规则、分支归属和 rewind 范围都应由运行时直接实现，而不是依靠提示词要求模型记住。

Iris Agent 的目标不是复制 Claude Code 的庞大系统提示词，而是保持规则少、边界明确，并把可以确定执行的规则放在代码中。

### 10. 整体产品模型

当前方案可以概括为：

- 一个分支只有一个 Agent、一条同步因果链和一个当前前台工具调用；
- 短命令仅记录，超过 3 秒的命令自动展示真实终端；
- 长命令运行时，模型每 20 秒检查一次新增输出；
- 正常检查不进入会话历史，异常时请求用户决定是否终止；
- 用户通过显式分支获得并发，不存在子 agent 或 Agent 自主异步；
- Agent 直接使用用户权限，不做安全沙箱和权限审批；
- Rewind 只恢复受管工具修改的代码，不覆盖其他副作用；
- 完整终端和模型原始上下文始终可以由用户检查；
- GUI 展示和操作真实工程对象，不用聊天卡片替代终端事实。

这套设计主动放弃自动并发、多 agent 编排、安全沙箱和全局事务回滚，换取简单、同步、透明、可预测的行为。它不是一个通用自治 Agent 平台，而是一个由用户直接控制、能够可靠完成工程任务的单 Agent 工具。

<br />

<br />

## 产品判断：Issue 之上的多 Session，Issue 之下的薄 Session

普通命令行 Agent 基本采用单 session 模型：项目目录下只有一条不断增长的对话。由于产品没有明确的 issue 概念，session 被迫同时承担需求、约束、调查过程、执行状态、阶段结论、任务连续性和历史入口。Session 因此越来越重；一旦另开 session，上下文就会断裂，而同时打开多个 session 又只会得到一组难以组织的聊天窗口。

没有 issue 这个上层工作对象，多 session 很难回答几个基本问题：这些 session 在解决什么，它们之间是什么关系，哪个仍在执行，哪个结论已经被采用，以及某个 session 结束以后任务当前处于什么状态。这样的多 session 只是多个窗口，不是可以理解和管理的工作结构。

Iris 已经具有明确、持久的 issue，因此可以采用不同的产品模型：

```text
Issue：持久的工作对象
  ├─ Session A：调查
  ├─ Session B：实施
  ├─ Session C：复核
  └─ Session A'：从 A 的某个节点分叉
```

Issue 保存问题为什么存在、目标是什么、已经确认的约束、当前进展、待办事项和最终结论。Session 只负责一段局部的理解与执行。项目连续性属于 issue 和其他持久文档，不属于任何单个 session。

所谓薄 session，不是 session 完全没有状态，而是它不再承担整个项目或问题的连续性。一个 session 只需要保存：

- 当前对话的局部因果链；
- 当前模型、提示词和上下文快照；
- 尚未完成的工具调用；
- 与它绑定的真实终端；
- 受管代码修改的 rewind 记录；
- 它所归属的 issue、父 session 和分叉点。

这些 session 可以随时创建、复制、分叉、切换或丢弃，因为值得长期保留的信息最终会回到 issue、status、report、代码、测试和 Git，而不是依赖某条会话永远存在。

### 三种 Session 派生方式

从 issue 新建 session 时，只继承 issue、项目规则和当前代码状态，不继承其他 session 的对话历史。这适合开始新的调查、重新实现或独立复核。

从当前节点分叉 session 时，继承原 session 到所选节点为止的对话上下文，并从那里建立新的因果链。原 session 保持不变。这适合尝试另一种实现，或者在原 session 正被长命令阻塞时，显式建立另一条工作路径。

复制 session 时，复制当前上下文和配置，创建一个独立副本。它适合更换模型、改变提示方式或从相同认知起点验证同一个判断。复制和分叉都不复制正在运行的进程或外部世界；正在运行的终端始终只属于原 session。

### Issue 是多个 Session 的组织点和收敛点

多个 session 不需要互相同步完整对话，也不需要一个父 Agent 在后台汇总子 Agent。它们通过 issue 间接协作：issue 为 session 提供稳定意图，session 将值得保留的发现和结果写回 issue，其他 session 重新读取 issue 获得已经确认的项目事实。

```text
Issue 提供意图与约束
  -> Session 进行局部理解与执行
  -> 重要发现、决策和结果写回 Issue
  -> 其他 Session 从更新后的 Issue 继续工作
```

分叉历史只用于维持局部推理连续性，跨 session 的长期共享通过文档完成。这样既避免复制几万 token 的聊天历史，也防止某个 session 成为无法替换的知识孤岛。

### 多 Session 是人的注意力结构

Iris 不应只提供按最近聊天排序的 session 列表，而应围绕 issue 展示它当前拥有的执行上下文：哪些 session 正在推理，哪些正在运行终端命令，哪些等待用户输入，哪些已经结束，以及它们之间的复制和分叉关系。

用户不是在聊天历史中寻找工作，而是在 issue 上查看当前有哪些执行路径，并决定把注意力切换到哪一条。Session 是 issue 下临时打开的工作台，不是独立项目。

### 这也是不设置子 Agent 的产品依据

Iris 已经有一套清楚的多执行单元模型：issue 负责组织，session 负责执行，分支负责派生，用户负责决定并发，文档负责收敛结果。

子 Agent 本质上是让模型在后台替用户创建、分配和管理 session。Iris 则把这些执行路径直接放在 issue 下，让用户显式创建和切换。这样可以获得多 session 和并行工作的能力，又不需要隐藏 delegation、父子 Agent 协议和自动任务编排。

因此，内置 Agent 最重要的产品变化不是 Iris 拥有了自己的模型调用能力，而是 session 的产品地位发生了变化：

> Session 不再是顶层工作对象，而是 issue 下可以随时创建、复制、分叉和丢弃的薄执行上下文。

命令行 Agent 因为缺少 issue，只能把 session 做得越来越重；Iris 因为已经拥有持久的 issue 和项目记忆，反而有条件把 session 做薄。围绕 issue 组织的多 session 不是混乱的聊天集合，而是围绕同一个真实问题展开的多条可见、可切换、可回收的执行路径。

## 运行时选型：基于 Pi SDK 构建 Iris Agent

此前的 Pi 调研认为 Iris 只应提供终端级支持，不接入 RPC 或 SDK；后续补充评估又在“只选择一个结构化后端”的假设下偏向 Codex app-server。这些判断建立在当时的产品边界上：Iris 不内置 Agent、不解析 Agent 输出，同时把安全、审批和 Windows 原生兼容视为结构化后端的重要价值。

现在的产品目标已经发生变化。Iris 明确要实现自己的 Agent，不做沙箱和权限审批，不设置子 Agent，需要支持第三方模型，并且要自行定义 issue 下的薄 session、长命令监督、真实终端和有限 rewind。Codex app-server 的沙箱、审批闭环和 Codex 自有 session 模型不再构成决定性优势，反而会限制 Iris 对核心交互语义的控制。Pi 的开放 Agent loop、多 provider、会话树和自定义工具接口则变成了更重要的基础能力。

当前选型结论是：

> 使用 Pi SDK 作为 Iris Agent 的可替换执行引擎；不把 Pi RPC 作为正式运行时，也不在现阶段 fork 整个 Pi。只有公开 SDK 出现无法绕过的必要障碍时，才 fork 最小的阻塞模块。

### 三种方案的判断

| 方案 | 优点 | 主要问题 | 结论 |
| --- | --- | --- | --- |
| Fork Pi | 可以完全修改 Agent loop、session 和工具行为 | Iris 将长期承担 provider、认证、流式协议、重试、压缩、TUI、RPC 和上游合并成本 | 现在不做 |
| Pi SDK | 可以直接注入 system prompt、自定义工具、session、模型和事件处理，同时复用上游 provider 与 Agent loop | 需要适配快速变化的 `0.x` API，并处理 Node 运行时和进程隔离 | 首选 |
| Pi RPC | 子进程隔离自然，协议简单，适合快速验证和外部客户端 | 工具、终端和 session 所有权留在 Pi 子进程，难以实现 Iris 特有语义 | 仅作测试参照 |

Pi SDK 已经公开提供 `AgentSession`、Agent 生命周期和事件流、自定义 system prompt、自定义工具、`ModelRuntime`、多 provider 认证、`SessionManager`、会话树、fork、clone、tree navigation、compaction、retry 和 abort。实现当前 Iris Agent 所需的大部分能力并不要求修改 Pi 内核。

### 为什么 SDK 能实现 Iris 的长命令语义

Iris 不使用 Pi 内置 `bash`，而是通过 SDK 注册自己的 terminal 工具。工具调用进入 Iris 后，由 Iris 创建和持有真实 PTY：

```text
Pi Agent loop
  -> 请求调用 Iris terminal tool
  -> Iris 创建真实 PTY 并执行命令
  -> 3 秒内结束则只记录结果
  -> 超过 3 秒则自动展示完整终端
  -> 每 20 秒用临时模型调用检查新增输出
  -> 正常检查不进入主会话历史
  -> 异常时请求用户决定是否终止
  -> 进程结束后返回一次最终 tool result
  -> Pi Agent loop 沿原因果链继续
```

20 秒检查不能通过 `AgentSession.prompt()` 实现，因为那会把监督过程写入 session。它应直接使用 Pi 的模型/provider 层发起一次临时判断，只携带监督提示、必要运行状态和终端增量，判断完成后丢弃临时上下文。完整终端始终由 Iris 保存。

### 为什么 SDK 能实现有限 Rewind

Iris 同样不直接使用 Pi 内置 `edit` 和 `write`，而是注册自己的受管文件工具：

```text
Pi 请求 edit/write
  -> Iris 执行文件修改
  -> Iris 记录正向修改和可应用的反向 patch
  -> Iris 返回结构化工具结果
```

Pi 保存 session 内的对话树，Iris 保存受管文件修改账本。用户 rewind 时，Pi 的对话状态回到对应 entry，Iris 撤销该节点之后由受管工具产生的代码修改。终端命令、进程、网络请求和其他外部副作用仍然不在 rewind 范围内。

这种分工不要求修改 Pi Agent loop，也不会把“代码可恢复”错误扩大为“外部世界可以回滚”。

### 为什么不采用 Pi RPC 作为正式内核

Pi RPC 适合为 Pi 编写一个新客户端，但 Iris 的目标不是给 Pi CLI 换一个 GUI，而是利用 Pi 的机制实现具有独立产品语义的 Iris Agent。

使用 RPC 时，Pi 子进程拥有 `AgentSession`、工具执行、Bash 进程和 session tree。Iris 只能消费 Pi 已定义的命令和事件。如果需要让 Pi 的工具调用进入 Iris 自己的 PTY 和受管编辑工具，就必须再编写 Pi extension，并建立一套从 Pi 子进程反向调用 Iris 主进程的工具协议：

```text
Iris -> Pi RPC -> Pi extension -> Iris tool RPC -> Iris terminal/file tools
```

这会增加一层协议、两套生命周期和更多故障边界。正常的 20 秒模型检查也无法自然做到不进入历史：RPC `prompt` 会进入 Pi session，而反复启动临时 Pi 进程又无法高效复用当前 provider 和模型状态。

因此 Pi RPC 只保留两个用途：快速验证 Pi 原生行为，以及作为 SDK adapter 的上游兼容参照。它不是 Iris Agent 的产品运行时。

### 为什么现在不 Fork Pi

Fork 可以提供完全控制，但也会让 Iris 接管 Pi 最昂贵、最缺乏产品差异的部分：

- 多 provider API 的持续变化；
- 模型目录、认证和 OAuth；
- 各 provider 流式协议和 tool-call 差异；
- retry、compaction 和 token/context 计算；
- Node/Bun、发布和打包兼容；
- 上游 bug 修复和版本迁移。

当前公开 SDK 已经暴露必要控制点，没有证据证明必须 fork。现在 fork 等于为尚未出现的障碍提前承担长期维护成本。

如果以后确实需要 fork，也不应 fork Pi 的完整 CLI/TUI 产品。优先继续使用上游 `pi-ai` 和 provider 适配，尽量保留 `pi-agent-core`；只接管真正阻塞 Iris 语义的 SessionManager、compaction 或 coding-agent adapter。Iris 不需要 Pi TUI、RPC mode 和 extension UI。

### Iris 与 Pi 的所有权边界

Iris 必须拥有产品语义和用户可见事实：

- Issue 与 Session 的组织关系；
- Session ID、父 session、复制关系和分叉点；
- GUI、分支交互和 context inspector；
- Iris system prompt、项目规则和焦点文档注入；
- read、edit、write 和 terminal 工具；
- PTY、完整输出和 20 秒长命令检查；
- 受管文件修改账本和 rewind；
- 哪些信息进入历史、哪些只保留在终端；
- Session 与文档的写回关系。

Pi SDK 只负责通用 Agent 机制：

- provider 适配和模型目录；
- 模型认证；
- 流式请求与响应解析；
- Agent loop 和 tool-call 协议；
- retry 和基础上下文/token 计算；
- 可选的 compaction 算法；
- 单个 session 内部的消息树。

Pi 的 `SessionManager` 可以作为一个 Iris session 内部的对话树，但不能成为产品顶层权威。Iris 自己的 session 元数据至少需要表达：

```text
IrisSession
  id
  issuePath
  parentSessionId
  forkEntryId
  piSessionId / piSessionFile
  terminalHandles
  mutationLedger
```

这些数据属于可丢弃的工作记忆，保存在 Iris 的本地用户数据目录，而不是写进 `.iris/` 项目协议。跨 session 值得长期保留的事实仍然写回 issue、status、report、代码、测试和 Git。

### Agent Worker 进程边界

Pi SDK 不应运行在 renderer 中，也不应直接混入 Electron main 的项目、PTY、Git 和文档生命周期。Iris 应建立自己的 Agent Worker：

```text
Renderer
  -> Iris main
    -> Iris Agent Worker
      -> Pi SDK
```

Worker 是可靠性和故障隔离边界，不是安全沙箱。Provider 请求卡死、Pi 崩溃或 Agent 内存异常不能拖死 Iris 的文档编辑、终端和项目状态。Iris main 仍然是项目 scope、文件修改、PTY 生命周期和 session 归属的权威。

当前存在一个实际运行时门槛：Pi `0.84.1` 要求 Node.js `>=22.19.0`，而 Iris 当前声明 Node.js `>=20`，并使用 Electron 31。正式实现前必须确认 Electron 所带 Node 版本是否满足要求；否则需要升级 Electron，或随应用提供一个明确版本的独立 Agent Worker runtime。不能依赖开发机恰好安装了 Node 24。

### 主动关闭 Pi 的产品能力

Iris 不应默认加载用户的 Pi 全局生态，否则 extensions、项目 `.pi/` 配置和其他资源可能在界面不可见的情况下改变 Agent 行为。应使用受控的 `ResourceLoader` 和明确配置：

- 不加载 Pi TUI；
- 不使用 Pi 内置 Bash、edit 和 write；
- 不自动发现或加载 Pi extensions；
- 不加载 subagent、permission 或 sandbox extension；
- 不允许项目 `.pi/` 内容静默改变 Iris Agent；
- skills 和项目上下文由 Iris 明确选择和展示；
- system prompt 完全由 Iris 组成，并在 GUI 中可检查；
- provider 配置和认证可以复用 Pi `ModelRuntime`，但 Agent 行为由 Iris 管理。

### 版本与维护策略

Pi 仍处于快速演进的 `0.x` 阶段。Iris 应采用以下策略控制耦合：

1. 精确固定 Pi SDK 版本，不使用浮动范围；
2. 所有 Pi API 只通过一个窄的 Iris adapter 使用；
3. 只依赖 Pi 正式导出的公开 SDK，不引用 `dist` 内部路径；
4. 为消息事件、工具调用、session fork、compaction 和错误状态保存协议 fixture；
5. 升级 Pi 时先运行 adapter contract tests，再进行真实 provider 验收；
6. 保留 Pi RPC 或原生 Pi CLI 作为行为参照，不把它们混入正式 session；
7. 如果公开 API 移除必要能力，先评估 adapter 绕行，再决定是否最小 fork。

### 分阶段落地建议

第一阶段只验证运行时边界，不追求完整 GUI：

1. 在独立 Worker 中启动一个使用 Pi SDK 的内存 session；
2. 注入 Iris 自己的最小 system prompt；
3. 使用一个 provider 完成流式消息和工具调用闭环；
4. 替换 read、edit、write 和 terminal 四类工具；
5. 验证工具错误、取消和 Worker 崩溃不会影响 Iris 主工作区。

第二阶段实现 Iris session 所有权：

1. 建立 issue 到多个薄 session 的映射；
2. 实现新建、复制、分叉、切换和丢弃；
3. 将 Pi 对话树映射到 Iris session 内部；
4. 实现受管文件修改账本与有限 rewind；
5. 保证运行终端不会随 session 复制或分叉。

第三阶段实现长命令和完整可观测性：

1. 接通 Iris 真实 PTY；
2. 实现 3 秒自动展示；
3. 实现不进入主历史的 20 秒增量检查；
4. 展示完整终端、原始 system prompt、最终上下文和裁剪信息；
5. 异常检查只请求用户决定，不擅自终止任务。

最终架构原则可以概括为：

> 不 fork 一个完整产品，也不通过 RPC 遥控一个完整产品；把 Pi SDK 当作可替换的 Agent 引擎，由 Iris 掌握 issue、session、工具、终端、rewind、上下文和 GUI。

## UI 产品判断：Session 选择条与 Agent 内部工作面

此前提出的“在 Issue 页面中增加 Session 导航”和“长终端出现后将 Agent 页面改为上下分栏”不符合 Iris 已有的右栏模型。Iris 已经拥有文档锚定的 session 选择条，不需要在 Issue 页面内再建立第二套 session 导航。新的 UI 设计以两级容器为基础：右栏顶部选择执行主体，Iris Agent 内部标签页选择该执行主体拥有的工作面。

```text
当前 Issue / 文档
  -> 右栏顶部 Session 选择条
    -> Iris Agent A
      -> Agent 内部标签页
        -> Agent
        -> Terminal 1
        -> Terminal 2
    -> Iris Agent B
      -> Agent 内部标签页
        -> Agent
    -> Claude / Codex / 普通终端
```

### Iris Agent 是现有 Session 列表中的第一等入口

右栏尚未打开任何 session 时，启动列表的第一项是“用 Iris Agent 打开”。Claude、Codex、其他 Agent CLI 和普通终端继续保留。

打开后，右栏上方现有的 session 选择条保持不变。Iris Agent 作为一种新的 session kind 出现在其中。选择普通 PTY session 时，下方仍渲染现有终端；选择 Iris Agent session 时，下方渲染 Iris Agent 界面：

```text
session.kind === "pty"         -> TerminalView
session.kind === "iris-agent"  -> IrisAgentView
```

Iris Agent 仍然锚定创建它的 issue、其他文档或 workspace hub。用户可以为同一个 issue 创建多个 Iris Agent，也可以同时保留外部 Agent CLI 和普通终端。中间文档区域不因为切换右栏 session 而改变。

### Agent 内部标签页属于单个 Iris Agent Session

`IrisAgentView` 顶部有一组局部标签页。新建 Agent 时只有一个固定的 `Agent` 标签，显示该 session 的对话界面。

当 Agent 启动需要观察的长命令时，才在该 Agent 内部增加终端标签：

```text
[Agent] [vivado] [npm test]
```

这一层不是新的 session 选择器，而是当前 Agent session 内部的工作面导航。右栏顶部选择条决定当前查看哪个执行主体；Agent 内部标签页决定查看该执行主体的对话还是它所拥有的终端。

### Agent 终端属于 Agent，不属于 Issue

Agent 调用工具创建的终端由该 Iris Agent session 持有，不直接属于 issue，也不作为独立项出现在右栏顶部的 session 选择条中。

```text
Iris Agent session
  owns conversation
  owns terminal A
  owns terminal B
```

这个所有权关系保证用户始终知道一个终端由哪条对话启动、结果要返回给哪个 Agent。切换到另一个 Iris Agent 时，只能看到另一个 Agent 自己的内部标签和终端，不会把多个 Agent 的工具现场混在 issue 级 session 列表里。

正在运行的终端随其 Agent session 保持存活。Agent session 被明确结束或丢弃时，其仍在运行的终端需要经过相应收尾。关闭一个已经结束的终端标签只关闭该工作面的视图，不删除对话历史中的工具执行记录。

### 3 秒终端规则在 Agent 内部生效

短命令执行时，Agent 历史中只显示精简的命令和最终结果，不创建终端标签。

如果命令超过 3 秒仍未结束：

1. 在当前 `IrisAgentView` 中创建一个新的终端标签；
2. 自动切换到这个标签，展示从命令启动开始的完整真实 PTY；
3. 用户可以随时切回 `Agent` 标签；
4. 用户主动切回后，后续输出不能反复抢走焦点；
5. 命令结束后终端标签继续保留，供用户回看和关闭。

因此长终端不会把 Agent 页面改造成上下分栏，也不会覆盖对话。Agent 和终端分别作为完整工作面在同一个 Agent session 内切换。这更适合长日志、alternate-screen TUI 和有限的右栏宽度。

如果命令在 3 秒内请求交互输入，应立即创建并显示终端标签，不等待超时。

### Fork 只派生对话历史

Fork 的语义严格限定为对话历史派生，不复制其他运行时状态、工作区状态或外部世界。

从某个历史节点 fork 后，会创建一个新的 Iris Agent session，并把它加入右栏顶部的 session 选择条。新 Agent 获得：

- 截止所选节点的对话历史；
- 根据该历史可以重建的模型上下文；
- 原 issue、文档或 workspace anchor；
- 必要的模型配置。

新 Agent 不获得：

- 原 Agent 正在运行或已经结束的终端；
- 进程句柄、PTY 状态或终端标签；
- 尚未完成的工具调用；
- 原 session 的 mutation ledger 所有权；
- 任何文件系统、Git、网络或其他外部副作用的复制。

两个 fork 后的 Agent 共享当前真实工作区，但从各自独立的对话历史继续。即使历史前缀相同，它们之后看到的磁盘状态也可能不同。UI 不制造“整个世界已经复制”的错觉。

### Fork 交互更接近 SillyTavern 的历史派生

这里借鉴的是 SillyTavern 对聊天历史分支的直接处理，而不是它的角色聊天外观：

- 用户从某个历史位置创建新的聊天；
- 新聊天复制该位置之前的消息前缀；
- 原聊天保持不变；
- 两边成为独立 session 并分别继续；
- 用户通过 session 选择器切换，而不是在一个 session 内管理任务图。

对话在数据上可以形成树：

```text
A -> B -> C -> D
          |-> E -> F
          `-> G -> H
```

但默认 UI 不需要持续展示大型分支图。Fork 产生的新 Agent 直接出现在右栏顶部选择条中；需要检查来源时，再在 session 详情中显示父 Agent 和 fork 节点。

Fork 与重新生成候选回答是不同能力。第一版优先实现 fork，不急于实现同一消息位置的 swipe/regenerate。特别是在已经发生工具调用后，重新生成不能暗示原工具副作用被撤销。

### 思考是模型当前状态，不是历史记录

模型正在推理时，Agent 页面显示一个实时活动状态，例如“正在思考”。思考结束后，这个状态立即消失或转为下一运行状态。

默认历史中不保留“思考了 23 秒”“Thought for 23s”之类的条目。思考时长、token、费用、provider retry 和其他运行统计不是对话语义，也不是项目事实。它们可以进入按需打开的调用详情或诊断视图，但不能持续占用默认历史和用户注意力。

同样，模型每 20 秒对长命令进行的正常检查不产生历史项。默认历史只保留用户需要理解和复核的内容：

- 用户消息；
- Agent 最终回答；
- 必要的文件修改摘要；
- 短命令及最终结果；
- 长命令的终端引用与最终状态；
- 异常判断和用户决策。

默认历史不展示思考卡片、正常监督轮询、内部重试、冗长工具参数或持续 token 统计。完整信息仍然可以在 context inspector、调用详情和真实终端中检查。

### 完整交互模型

```text
用户选中 Issue 或文档
  -> 在右栏启动列表点击“用 Iris Agent 打开”
  -> 右栏顶部新增并选中一个 Iris Agent session
  -> 下方显示 IrisAgentView，内部初始只有 [Agent]
  -> Agent 执行短命令
    -> 对话历史显示精简结果
  -> Agent 执行超过 3 秒的命令
    -> IrisAgentView 新增 [Terminal] 标签并切换过去
    -> 用户查看完整终端，或主动切回 [Agent]
  -> 用户从某个历史节点 Fork
    -> 右栏顶部新增另一个 Iris Agent session
    -> 只复制对话前缀，不复制终端和其他运行时状态
```

这套设计形成三个明确层次：

- Issue 或文档锚定多个 session；
- Iris Agent 是一种 session；
- 终端是 Iris Agent session 内部拥有的工具工作面。

最终产品原则是：

> 右栏顶部选择条负责切换执行主体，Agent 内部标签页负责切换这个执行主体拥有的工作现场；Fork 创建新的执行主体，但只继承对话历史。

## 完整开发路线图

路线图只分为四个大阶段：**验证、MVP、核心功能、外围功能**。阶段之间是硬依赖，不是可以交错完成的功能分组。两个关键里程碑是：

1. **Agent UI 第一次打开**：证明 Iris Agent 已成为 Iris 内部真实可达的产品界面。
2. **允许开始自举开发 Iris**：证明它能围绕真实 Issue，在正确提示词和最新文档上下文中，可靠地修改 Iris、观察终端、写回结果并接受审计。

“UI 能打开并与模型对话”不等于“可以自举”。第三阶段全部通过之前，Iris Agent 只用于受控验证，不能用来实现自身尚未完成的核心能力；自举从第四阶段开始。

### 总体架构与所有权

    Renderer
      -> Iris main / AgentController
        -> Agent Worker
          -> Pi SDK
          -> provider

    Agent Worker
      -> tool request
        -> Iris main / ToolHost
          -> managed file tools
          -> PTY and terminal runtime
          -> project-scoped read tools

    Iris main
      -> normalized Agent events
        -> renderer projection
        -> local Session store
        -> document watcher

所有阶段遵守同一条边界：

- Renderer 只显示状态和发送明确的用户操作；
- Iris main 拥有 workspace、Issue、Session、工具、文件 revision、mutation ledger、PTY、终端归属和持久化；
- Agent Worker 只拥有 Pi SDK、provider 请求、流式事件和单次严格同步的 Agent loop；
- Pi 不直接修改文件、不创建 Iris 可见终端，也不定义 Iris 的 Session、Fork、Rewind 和文档语义；
- .iris/ 文档是项目长期记忆，Agent Session 是本机保存、可以复制和丢弃的薄执行上下文；
- Git 继续承担长期版本与交付，Session 和 Rewind 都不能冒充 Git；
- 不设子 Agent，不建设通用异步任务图，不做沙箱、命令审批和互联网权限礼仪。

### 第一阶段：验证

目标是先消除会导致整体返工的技术不确定性，证明 Pi SDK 能被限制在 Iris 所需的引擎边界内。本阶段只做可丢弃的 spike、协议草案和自动化验证，不建设正式 UI。

#### 引擎与进程边界

- [ ] 精确锁定一个 Pi SDK 版本，不使用浮动版本范围。
- [ ] 验证 Electron/Node 运行时要求，并确定随安装包交付的 Agent Worker runtime 方案。
- [ ] 在独立 Worker 中完成用户消息、流式回答、自然结束、取消和错误恢复。
- [ ] 用 Iris 自己的 AgentEngine 草案包住 Pi，确认 Renderer 和业务层不依赖 Pi 类型。
- [ ] 验证 Worker 崩溃不影响文档编辑、普通终端、Git 和其他 Session。
- [ ] 关闭 Pi TUI、extensions、项目 .pi/ 配置、默认工具、subagent 和默认上下文发现。
- [ ] 验证自定义工具的 start、incremental、result、error 和 abort 事件序列。
- [ ] 验证 Agent loop 可以完全不使用 Pi 内置 bash、edit 和 write。
- [ ] 验证 provider/model 层可执行不写入正式 Session 历史的临时模型调用。
- [ ] 验证稳定消息节点、上下文重建、clone 和指定节点 fork 所需的公开 API。

#### Iris 联动可行性

- [ ] 用 spike 直接组装 App 内置 software prompt、canonical project prompt、固定 anchor 快照、Session 历史和 Iris tool schema。
- [ ] 验证内置 Agent 不从 AGENTS.md、CLAUDE.md 等 vendor 镜像反向读取项目提示词。
- [ ] 验证发送前可以 flush 编辑器并取得带 revision 的最新 Issue 或文档快照。
- [ ] 验证 Iris main 能以 revision/CAS 处理 Agent 文件写入，并把冲突返回模型和 UI。
- [ ] 验证现有 PTY 能从进程启动时保存完整输出，并支持增量游标读取与重放。
- [ ] 形成版本化 Worker 协议、工具协议、Session schema 和 correlation ID 草案。

#### 阶段退出门槛

- [ ] Pi 的公开 SDK 足以支持流式 Agent loop、自定义工具、临时监督调用和历史派生。
- [ ] Iris 可以完全控制 system prompt、项目上下文、工具副作用和终端归属。
- [ ] Worker runtime、安装交付方式和升级测试策略已经确定。
- [ ] 关键方案不依赖 Pi 未承诺的内部 dist 路径。

若最后一项无法满足，只评审阻塞能力的最小 fork；不 fork Pi TUI、RPC 或完整产品。验证结束时必须明确选择“Pi SDK + 窄适配层”或“Pi SDK + 最小补丁 fork”。

### 第二阶段：MVP

目标是先让 Iris Agent 作为真实 Session 出现在右栏，再完成单 Issue、单 Session、短任务的最小纵向闭环。本阶段刻意不实现多 Session、Fork、Rewind、长命令监督和完整诊断，因此完成 MVP 后仍不能开始自举。

#### 基础运行骨架

- [ ] 实现独立 Agent Worker、带版本 IPC 和窄 PiAgentEngineAdapter。
- [ ] 为 request、Session、turn、tool call、model request 和 PTY 分配贯通的稳定 ID。
- [ ] 实现 Worker 启动、ready、停止、崩溃、超时和清理状态机。
- [ ] 在 Iris main 建立最小 ToolHost，提供结构化 read、edit、write 和 terminal。
- [ ] 文件工具走 Iris 的 project scope、原子写入、revision/CAS 和 mutation queue，Worker 不直接写盘。
- [ ] terminal 工具通过 Iris main 创建真实 PTY，并保存命令、cwd、环境、状态、退出码和完整输出。

#### 关键里程碑一：Agent UI 第一次打开

- [ ] 在右栏未打开终端时，将“用 Iris Agent 打开”放在启动列表第一项。
- [ ] 新增独立的 iris-agent Session kind；右栏顶部选择条继续切换执行主体。
- [ ] 实现 IrisAgentView，初始只包含一个固定的 Agent 内部标签。
- [ ] 从真实 Issue 或 workspace hub 创建 Agent Session，完成一次真实 provider 流式对话。
- [ ] 显示实时“正在思考”、流式正文、停止、失败和重试；历史不保留“思考 X 秒”。
- [ ] 默认历史只显示用户消息、最终回答和紧凑工具事件。

达到这个里程碑只说明产品入口和事件链成立。此时允许继续开发 MVP，但不允许宣布 Agent 可用，更不允许开始自举。

#### 最小工作闭环

- [ ] Session 创建时固定 anchor；切换中间文档或右栏 Session 都不改变它。
- [ ] Hub Session 注入明确的 workspace/root 上下文，并在没有具体任务时等待用户指令。
- [ ] 实现 software prompt、canonical project prompt、最新 anchor 快照、历史和 tool schema 的最小请求组装。
- [ ] 每次正式发送前 flush anchor 文档，再从磁盘读取最新 revision 和内容。
- [ ] 文件读取显示紧凑记录，文件修改显示路径与 diff 摘要，并能打开真实文件或 diff。
- [ ] 3 秒内结束的命令只显示命令、退出状态和精简结果，不创建终端标签。
- [ ] Agent 更新当前 Issue 后，由 Iris watcher 刷新编辑器，不在聊天 UI 维护第二份文档状态。
- [ ] 工具失败必须以明确取消或结构化错误到达模型和 UI，不能静默吞掉。
- [ ] 建立 Worker、adapter、ToolHost 和基础 UI 测试，确认普通 PTY 与外部 Agent CLI 没有回归。

#### 阶段退出门槛

- [ ] 从真实 Issue 完成一次“读 Issue -> 读代码 -> 修改 -> 短测试 -> 写回 Issue -> 最终回答”的受控任务。
- [ ] 模型实际使用 canonical project prompt 和发送前最新的 Issue 内容。
- [ ] 所有文件和终端副作用都经过 Iris main，并可追溯到 Session 和 tool call。
- [ ] 默认 UI 精简，但错误、diff 和短命令结果均有可达入口。
- [ ] 明确标注 MVP 尚不具备自举资格。

### 第三阶段：核心功能

目标是把 MVP 从“能完成短任务的 Agent 界面”变成“可以可信地开发 Iris 自身的工作系统”。Issue、提示词、Session、工具、终端、写回、Fork、Rewind 和可观测性必须形成完整契约；任何一项未完成，都不能越过自举门禁。

#### Issue、提示词与 Session 联动契约

每次正式模型请求按以下顺序组装：

    App 内置 software prompt + version
    .iris/settings.json canonical project prompt + revision
    固定 Session anchor
    发送前 flush 后的最新 Issue/文档快照 + revision
    Session 对话历史
    Iris tools schema + version

- [ ] 将 App 内置模板作为 <iris-software> 的直接来源，并记录 version/fingerprint。
- [ ] 将 .iris/settings.json / prompts.project 作为项目提示词唯一真相源，并记录 revision/fingerprint。
- [ ] 将 AGENTS.md、CLAUDE.md 等受管块只视为外部 CLI 的单向投影。
- [ ] 定义固定 Session anchor、hub anchor、focus snapshot 和中间文档选择的精确关系。
- [ ] 每次发送前强制完成 editor flush、磁盘重读和 revision 捕获，避免读取未保存旧内容。
- [ ] 为每次正式请求保存实际发送层的来源、顺序、revision、fingerprint、裁剪和压缩信息。
- [ ] 内置 Agent readiness 以 canonical project settings 可读和 anchor 已保存为准。
- [ ] vendor 镜像漂移只影响外部 CLI readiness；内置 Agent 显示 prompt health，但不被无关漂移阻断。
- [ ] Agent 写回 Issue 必须经过 Iris 受管文件工具、revision/CAS 和 watcher 刷新链。
- [ ] 用户或其他 Session 并发修改同一 Issue 时显式冲突，禁止静默覆盖。
- [ ] 方案、结果和待办继续写回 Issue；Session 历史不能成为项目唯一记忆。

#### 薄 Session、多 Session 与 Fork

- [ ] 定义并版本化 IrisAgentSession schema，包括 anchor、父 Session、fork 节点、模型配置、Pi 引用和生命周期。
- [ ] Session 元数据、历史、lineage 和 mutation ledger 保存在用户数据目录，不写入项目 .iris/。
- [ ] 一个 Issue 可以拥有多个 Iris Agent Session，并与普通 PTY 一同出现在右栏顶部选择条。
- [ ] 实现新建、复制、切换、重命名、归档、结束、删除和应用重启后的历史恢复。
- [ ] Session 列表显示思考、工具运行、等待用户、空闲、失败和结束状态。
- [ ] 为可 fork 的完成态消息分配稳定节点 ID，并提供 SillyTavern 式历史派生入口。
- [ ] Fork 只复制到指定节点为止的对话前缀、anchor 和必要配置。
- [ ] Fork 不复制终端、进程、未完成工具、mutation ledger、工作树、Git、网络或其他外部状态。
- [ ] 禁止从未完成工具调用中间状态 fork；派生 Session 重新读取当前磁盘事实。
- [ ] Issue 状态与 Session 生命周期解耦，结束 Session 不擅自关闭 Issue。

#### Agent 所属终端与同步长任务

- [ ] 每个 Agent Session 的内部工作面固定包含 Agent，并可加入其拥有的 Terminal 标签。
- [ ] terminal 启动时立即记录完整 PTY；运行超过 3 秒或提前请求交互时才显示 Terminal 标签。
- [ ] Terminal 从第一个字节重放完整输出，复用 xterm、输入、搜索、scrollback、resize 和 history freeze。
- [ ] Agent Terminal 只存在于对应 IrisAgentView 内，不出现在 Issue 级选择条。
- [ ] 用户切回 Agent 后，后续输出不再抢占标签。
- [ ] 结束 Session、关闭窗口和项目切换时明确处理仍运行的 PTY，不产生无主进程。
- [ ] 单 Session 严格同步：terminal tool call 完成前，主 Agent loop 不继续依赖它的步骤。
- [ ] 长命令每 20 秒按输出游标取得新增内容，并发起隔离的临时监督调用。
- [ ] 监督只接收命令元数据、必要重叠日志、增量输出和进程状态，不执行工具，也不进入正式历史。
- [ ] 正常结果不进入后续上下文和默认 UI；异常只请求用户决定继续或终止。
- [ ] 命令完成后停止监督，只向主 Agent loop 返回一次最终结构化结果。
- [ ] 同时处理另一件事时新建或 Fork 薄 Session，不让原 Session 绕过因果限制异步前进。

#### 有限 Rewind

- [ ] 每次 edit/write 成功后记录对话节点、tool-call ID、文件 revision、正向 diff 和反向 patch。
- [ ] Rewind 前预览受管文件修改，并明确终端命令、Git、网络和其他副作用不会回滚。
- [ ] 应用反向 patch 前验证 revision；同一区域已变化时停止并显示冲突。
- [ ] 只有文件恢复全部成功后才移动对话叶节点。
- [ ] Fork 与 Rewind 独立：Fork 不自动回滚文件，Rewind 不删除原 Session。
- [ ] 覆盖创建文件、连续修改、外部修改、部分失败和跨 Session 冲突测试。

#### 最小完整可观测性

- [ ] 实现 Context Inspector，展示实际发送的 system、项目规则、anchor 快照、历史、工具 schema、摘要和裁剪。
- [ ] 每个上下文块显示来源、顺序、revision/fingerprint、是否实际发送和 token 估算。
- [ ] 工具详情展示原始参数、结构化结果、错误、文件 diff、关联终端和 correlation ID。
- [ ] 模型详情展示 provider、模型、请求状态、重试、usage 和完整错误链。
- [ ] Worker、model request、turn、tool call、文件 mutation 和 PTY 使用同一 correlation 链。
- [ ] 完整终端始终可从内部标签或工具事件进入，摘要不能替代原始输出。
- [ ] 认证凭据不得进入 Inspector、Renderer 状态、项目文件或普通日志。

#### 关键里程碑二：允许开始自举开发 Iris

下列条件必须在同一个真实 Iris Issue 上端到端通过，不能由互不相连的演示拼成：

- [ ] 从真实 Issue 创建 Agent，并确认 Session anchor 在任务中保持稳定。
- [ ] 检查实际请求，确认使用正确版本的 software prompt、canonical project prompt 和发送前最新 Issue。
- [ ] Agent 读取 Iris 代码、实施范围可控的真实修改，并通过受管工具产生可审计 diff。
- [ ] 运行真实短测试和超过 3 秒的长命令，确认完整终端可见、20 秒监督不污染历史。
- [ ] Agent 将方案、结果和待办写回原 Issue，并验证 watcher 刷新与并发冲突。
- [ ] 从完成态节点 Fork，确认新 Session 只继承对话前缀并读取当前真实工作区。
- [ ] 对受管修改执行 Rewind，确认范围准确且不声称撤销其他副作用。
- [ ] 从一次故意制造的 prompt、工具或 provider 错误追溯到实际上下文、错误链和终端证据。
- [ ] 完成 Worker 崩溃、应用重启、项目切换和普通 PTY/外部 CLI 回归测试。
- [ ] 由人工明确确认 Iris Agent 已达到自举准入标准。

只有最后一项被人工确认后，才允许用 Iris Agent 开发其自身或第四阶段功能。第三阶段之前的实现仍由现有开发工具完成。

### 第四阶段：外围功能

目标是在核心语义稳定、Agent 获准自举之后，补齐长期使用、跨 provider、运维、性能和发布体验。本阶段可以把 Iris Agent 作为主要开发工具，但结果仍需写回真实 Issue 并接受人工审查。

#### 产品化与日常体验

- [ ] 产品化 provider 登录、登出、健康状态、模型选择和 thinking level，凭据只在受控主进程存储。
- [ ] 对 thinking、tool call、图片、上下文窗口和 usage 差异做显式 capability 降级。
- [ ] 扩展 Context Inspector 的请求对比、token/usage、重试详情、压缩历史和诊断导出。
- [ ] 完善 Session 搜索、排序、重命名、归档、恢复和 lineage，默认 UI 不常驻大型分支图。
- [ ] 完善 diff、终端标签、历史定位、错误恢复和长任务诊断。
- [ ] 评估同一节点多候选回答的 swipe/regenerate；不得暗示既有副作用已撤销。
- [ ] 保留普通终端和外部 Agent CLI 作为一等入口与故障逃生路径。

#### 可靠性、兼容性与发布

- [ ] 为 Session store、mutation ledger 和协议建立 schema 迁移，升级时不静默丢失历史。
- [ ] 验证多个 Issue、多 Agent、多普通终端并存时的内存、IPC、PTY 和持久化负载。
- [ ] 为长对话、超大 diff、高输出终端和频繁 Fork 建立资源预算与明确降级。
- [ ] 覆盖窗口关闭、renderer reload、Worker 崩溃、provider 断线、应用重启和安装版 runtime。
- [ ] 在 Windows、PowerShell/cmd/Bash 和至少两个 provider 上完成真实项目验证。
- [ ] Pi SDK 升级必须运行 adapter contract tests 和真实 provider smoke，不追随 latest。
- [ ] 审计 Pi 与新增依赖的许可证、第三方声明、安装体积和启动成本。
- [ ] 更新 README 和产品内说明，准确描述 Agent、外部 CLI、Fork、Rewind 和长任务边界。
- [ ] 用真实 Issue 完成“打开 Agent -> 修改 -> 短测试 -> 长命令 -> Fork -> Rewind -> 写回 -> Git 提交”的发布验收。
- [ ] 发布前由用户决定是否合并和启用，Agent 不自行把实验实现视为稳定功能。

### 明确不做

除非未来另行改变产品决策，这条路线图不包含：

- 子 Agent、模型自动委派或后台多 Agent 编排；
- 单个 Session 内绕过因果顺序的通用异步任务；
- 沙箱、网络权限礼仪和普通命令审批系统；
- 将 Agent 工具终端提升为 Issue 级独立 Session；
- 将正常 20 秒监督、思考时长或 provider 内部事件写入默认历史；
- 让 Fork 复制终端、进程、工作区或其他外部状态；
- 让 Rewind 回滚终端命令、Git、网络、数据库或其他副作用；
- 默认加载 Pi extensions、subagent、permission、sandbox 或项目 .pi/ 配置；
- fork Pi TUI、RPC 和完整产品；
- 用聊天卡片或模型摘要代替真实终端、文件 diff 和项目文档。

### 实施顺序与自举边界

    第一阶段：验证
      -> 第二阶段：MVP
           -> 里程碑一：Agent UI 第一次打开
           -> 单 Issue / 单 Session / 短任务闭环
      -> 第三阶段：核心功能
           -> Issue + Prompt + Session 联动
           -> 多 Session + Fork + Rewind
           -> 完整终端 + 20 秒监督
           -> 写回 + 冲突 + 可观测性
           -> 里程碑二：人工确认允许自举
      -> 第四阶段：外围功能
           -> 开始使用 Iris Agent 自举开发
           -> 产品化、兼容性、可靠性与发布

最重要的产品判断是：**第一次打开 UI 是存在性证明，自举门禁才是可信性证明。** 两者之间的第三阶段不能压缩成“边用边补”，因为提示词来源错误、Issue 内容过期、写回冲突不可见、终端输出缺失或 Rewind 语义虚假，都会让自举把 Agent 自身的缺陷继续写回 Iris。
