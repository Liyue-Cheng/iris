---
title: Tools 与 Whiteboard 设计哲学讨论逐字稿
status: Active
---
# Tools 与 Whiteboard 设计哲学讨论逐字稿

> 记录日期：2026-09-07
>
> 本文记录本次关于 Iris Agent 的 Tools 边界、Whiteboard、自然语言智能和 Issue 状态机的讨论。保留用户与 Agent 的实质发言原文；调研命令、终端输出和过程性提示不纳入逐字稿。

## 用户

然后我们讨论下一个问题：什么是tools？我们的设计哲学中，tools应该进行承载agent和世界之间真正的认知方式和信道，而不是将乱七八糟的东西全部塞进去，因此，我们的tools设计相对简洁，未来可能会加入whiteboard和webfetch和webserch。我的意思就是，要信任模糊智能和自然语言，能在context中讲清楚的，不要做成tools。所以，我拒绝deepseek harness的设计方案（你可以查查这个新东西）调研一下，然后谈谈你对这个设计哲学的理解

## Agent

我的结论是：你这里说的 Tool，不应该被定义为“模型可以调用的函数”，而应该定义为：

> Tool 是 Agent 跨越自身 Context，感知或改变外部世界的一种受宿主管理的认知器官。

这个定义与 DeepSeek Harness 的差异非常根本。DSH 追求的是“任何能力都可以插件化，并按需暴露成模型工具”；Iris 追求的则应该是“只有不可被语言推理替代的世界能力，才值得暴露成 Tool”。

## 四个平面应该分开

| 平面 | 承载什么 | 典型内容 |
| --- | --- | --- |
| Context | 模型应该知道什么、如何做事 | 项目规则、Skills、当前任务、设计原则 |
| Tool | Agent 如何感知或改变世界 | 文件、终端、Web、白板 |
| Control Plane | Harness 如何可靠运行 | retry、compact、provider 切换、Stop、权限、调度 |
| Projection / Artifact | 给人看的工作状态 | plan、todo、进度、状态卡片 |

DSH 的争议在于，它允许后三类不断向 Tool 平面坍缩。例如目前官方仓库中存在：

- `get_goal/create_goal/update_goal`
- `todo_write`
- `skill`
- 五个 session history 查询工具
- `workflow`
- `job_output/job_list/job_kill`
- subagent 通信和团队任务板工具
- 甚至 `cordis_define/run/stop/undefine`，让模型动态扩展 Harness 自身

这套实现并不粗糙。相反，DSH 的 schema、scope、取消、guard、pre/post execution 和错误结算都很严谨。问题是：模型开始通过 CRUD API 管理自己的目标、计划、记忆、工作流和运行时。Tool 从“认知器官”逐渐变成了“Harness 的 RPC 总线”。

这就是我理解的你拒绝它的原因。

## 为什么不应把认知过程工具化

工具化思路是：

```text
模型的认知活动
  → 映射成 Harness 预定义的结构
  → 调用 plan_create / todo_update / ask_user / goal_complete
  → Harness 保存状态
```

Whiteboard 思路则是：

```text
模型理解当前任务
  → 用自然语言把必要状态写进 Markdown
  → 人和模型共同阅读、修改和解释
```

前者由 Harness 预先规定模型可以怎样思考；后者只给模型一个稳定媒介，让智能自己决定怎样组织问题。

把计划、拆解、判断下一步、回顾历史、决定是否继续做成工具，会把模糊智能过早固化成 schema，制造第二份认知状态，增加无意义的动作空间，并把 Harness 内部实现泄漏给模型。结构化调用只能保证参数形状正确，不能保证计划合理或目标真的完成；这些语义判断最终仍然来自模糊智能。

因此，“信任自然语言”并不是拒绝工程约束，而是把约束放回正确的层：

- 策略、方案、判断使用自然语言；
- 权限、并发、持久化不变量使用宿主代码；
- 只有与世界交互才使用 Tool。

## 什么东西有资格成为 Tool

我认为可以用一个很严格的判断标准：

> 如果不调用它，模型是否缺少一种无法从现有 Context 中推理出来的新观察或新作用？

符合以下特征的，才像真正的 Tool：

- 结果依赖当前世界状态，模型不能凭空知道；
- 调用会产生真实副作用；
- 跨越了进程、文件系统、网络、人类或其他模态边界；
- 需要宿主进行权限、取消、超时和结果结算；
- 它是跨任务稳定的基础能力，而不是某种工作流习惯。

依此来看：

- `read/edit/write`：文件世界的感知与作用信道。
- `terminal`：对操作系统和外部程序的通用感知—行动信道。
- `web_search`：发现当前外部信息。
- `web_fetch`：读取指定网络资源。
- `whiteboard`：如果只是保存计划，不应成为 Tool；如果它提供真正的二维空间、视觉关系、人与 Agent 共同操作的持久画布，那么它是一种自然语言无法完全替代的新模态，应该成为 Tool。
- `ask_user`：本体上确实是一条通往人类世界的信道，但在 Iris 中，人类输入已经是一等 Session/Intent 事件，所以未必需要伪装成普通 Tool。
- `todo/goal/plan/skill-load`：通常不是 Tool。
- `retry/compact/provider-switch/Stop`：明确是控制平面，不是 Tool。
- `workflow/subagent management`：更像执行编排；除非 Iris 把另一个 Agent 明确定义为外部认知服务，否则不应自然地混入世界工具集合。

## 它与 Iris 当前模型非常契合

Iris 已经区分：

```text
模型提出 ToolCall
        ↓
宿主执行 Tool Operation
        ↓
返回关于世界的结算结果
```

这其实已经隐含了一个非常漂亮的定义：

> ToolCall 是 Agent 对世界提出的一次感知或行动请求；Tool Operation 是宿主对该请求的现实结算。

因此 Tool 不应该承载“模型决定怎样想”。它只负责让模型能够看见自己原本看不见的东西，或者影响自己原本无法影响的东西。

我会把 Iris 的工具哲学浓缩成一句话：

> Context 承载意义，Agent 承载判断，Runtime 承载秩序，Tools 只承载世界。

DSH 值得吸收的是严谨的工具执行流水线、作用域、取消与错误结算；不应该吸收的是它不断把 Harness 内部能力转换为模型工具的扩张标准。

## 用户

可以的，然后是我对whiteboard的理解：这就是md文档， plan ask todo 之类的杂七杂八的全部塞进去。然后通过写作规则prompt来加载和卸载对应功能，不要搞那么多tools。总而言之，就是信任自然语言智能，而不是搞乱七八糟的那么多硬编码 谈谈你对这个思路的理解。

## Agent

我很认同。你说的 Whiteboard 本质上不是一种新的世界工具，而是 Agent 与人共同维护的“外置工作记忆”：一份普通 Markdown 文档。

它可以同时承载：

```markdown
# 当前目标

# 已知事实

# 计划

# 待确认问题

- [ ] 用户决定是否采用方案 A

# Todo

- [ ] 调研现有实现
- [ ] 修改协议
- [ ] 验证结果

# 决策

# 工作结果
```

Plan、Ask、Todo、Memory、Progress 在这里都不再是独立产品能力，而只是不同的写作行为。

“加载功能”其实是加载写作规则：需要 Plan 时加载如何在 Whiteboard 中写计划的规则，需要 Todo 时加载如何维护任务复选框的规则，需要 Ask 时加载如何记录待确认问题并向用户提问的规则。不需要时，不加载相应规则，也不向模型暴露额外 schema。

对 Ask 来说，Agent 可以在 Whiteboard 中写下待确认问题，把等待用户行动的事项写成复选框，在正常回复中向用户提问，用户回答后继续并更新文档。对话本身已经是人与 Agent 的信道，再增加 Ask Tool，相当于把已经存在的信道包装了一遍。

这种方式有很强的组合性。一个任务可以同时出现有条件的计划、尚未确认的假设、做到一半发现的新问题、暂时搁置的分支、用户否决的方案和仅供参考但不必执行的建议。自然语言可以直接表达：

> 如果实验 A 成功，则继续方案 B；否则先询问用户是否接受兼容性退化。当前不应执行迁移。

这种信息很难被固定的 `todo.status` 或 `plan.step` 准确承载，却是模型最擅长理解的东西。

但不要把 Markdown 再造为伪数据库。不要为 Whiteboard 发明几十种严格标签、ID、revision、状态枚举和命令语法；否则只是把 Tool schema 换成了 Markdown schema。更好的原则是：薄结构，厚语义。机器只识别少量稳定结构，例如 Markdown 标题、GFM 复选框、Iris 已有的少量 frontmatter、普通链接和引用。计划为什么这样安排、问题意味着什么、完成标准是什么，都留在自然语言正文里。

“信任自然语言”仍然有边界。权限、安全和路径边界，持久化原子性、并发和 revision，Tool Operation 的取消、超时与错误结算，仍然必须由 Runtime 硬保证，但也不应该变成模型工具。

我把这套思想概括为：

> 不要为 Agent 的每一种思维动作造一个按钮；给它纸和笔，告诉它必要的写作纪律，然后相信它会思考。

Whiteboard 就是这张纸。它不是 Plan Tool、Todo Tool 和 Ask Tool 的容器，而是让这些“工具”根本不再需要存在的统一认知媒介。

## 用户

信任自然语言智能，而不是搞乱七八糟的那么多硬编码 你可以看看早期的产品文档，然后谈谈你对这个思想的理解

## Agent

继续回看早期文档后，我认为这不是后来为 Whiteboard 临时提出的新偏好，而是 Iris 最初就存在、现在终于延伸到 Agent 内核的一条主线。

早期《软件定义书》已经写出了几句几乎可以作为今天讨论的答案：

- “模糊优于精确”
- “智能优于规范”
- “键是硬的，值是软的”
- “Types as lenses, not schemas”
- “确定性预算集中花在渲染层”
- “文件才是契约”

见 [software-definition.md](E:/projects/iris/software-definition.md)。

## Issue 状态机是最好的样板

当前的状态机规定了：

```yaml
status: Todo
status: In Progress
status: In Review
status: Done
```

但 Iris 没有必要给 Agent 提供 `get_issue_state`、`transition_issue_state`、`resolve_issue` 或 `block_issue`。AI 直接读取 Issue，理解工作现实，然后编辑 `status:`。Prompt 负责告诉它状态含义和迁移纪律；App 只负责按字面读取、投影、可靠写入，并在异常值出现时优雅退化；它不替 AI 判断工作是否真的完成。

这里的精确分工是：

```text
Prompt 定义语义
AI 判断现实
Markdown 保存事实
App 确定性投影
```

所谓状态机不是一个必须通过 API 操作的运行时对象，而是一套关于文档字段的语言协议。

## 早期 Iris 到处都是同一个模式

Todo 从一开始就不是独立任务数据库，而是 Issue 正文中的 GFM checkbox。App 聚合并投影这些行，需要时精确写回原文，所以 Agent 不需要 `todo_create/todo_update/todo_complete`。

Workspace 不需要 `create_workspace_definition` 或 manifest。目录里出现 typed folders，它就被推断为 workspace。

Label 早期方案明确提出“不建标签注册表”：标签词表就是项目文档中实际出现值的并集。

Asset 没有数据库索引和 manifest。Markdown 链接与磁盘文件本身就是索引。

这些设计共同表达了同一个原则：

> 不要先建立抽象对象，再让文档成为对象的展示；文档本身就是对象，应用只提供投影。

## Whiteboard 是这条路线的自然完成

Whiteboard 可以理解成比 Issue body 更自由的共享工作面。Plan、Ask、Todo、Memory、Progress 都是写作形式，不是五个领域服务。“加载和卸载功能”不是改变工具目录，而是改变当前 Context 中的写作规则：加载 Plan 规则、Ask 规则或 Todo 规则；任务结束后不再注入这些规则，但 Markdown 成果继续存在。

这实际上是一种“语言级插件系统”。扩展的不是 Agent 可以调用的函数，而是它可以采用的工作方法。

## 真正应该硬编码什么

“信任自然语言”不等于拒绝所有确定性程序。确定性预算应该集中花在渲染层和正确性边界。

可以概括为：

> 硬编码字母表，不要硬编码句子。

应该硬编码 `status:` 这个字段、少量规范状态值、GFM checkbox 语法、typed folder 名称、原子写入、CAS、冲突处理、Tool 的取消和错误结算、权限和安全边界；不应该硬编码 Agent 为什么以及何时改变状态、`transition_issue_state` 工作流、Todo 的完整领域服务、项目组织方式和内容模板、Plan 的阶段和步骤枚举、Agent 应该怎样思考下一步，或用 Prompt 伪装安全限制。

硬编码应该保护事实不被损坏，而不应该枚举智能能够怎样工作。

## 自然语言优先的边界

Iris 不应该自己去模糊解析自然语言，不应由程序猜测一段文字是不是计划、某句话是不是在等待用户，或 Agent 是否已经完成第三步。这些判断应该由人和 AI 完成。App 只识别少量明确标记，例如 frontmatter、标题、checkbox 和链接。

这样可以保留早期设计中的优雅降级：AI 完全遵守约定时，UI 可以提供丰富投影；AI 写得稍有不同，文档仍然可读、可改、可交接；App 消失后，文件仍然成立；换一个模型后，不需要重新实现全部工具适配；新工作方法可以先通过 Prompt 出现，无须等待产品开发。

## 对这条哲学的整体理解

Iris 不是在构建一个让 AI 操作的大型 PM API，而是在构建一种适合 AI 与人共同书写的项目语言。

Markdown 是源代码，Prompt 是语言规范，AI 和人是作者，Iris App 更像编译器与工作台：

```text
自然语言和少量字面结构
            ↓
       Markdown 事实
            ↓
Iris 确定性扫描、投影和可靠写回
            ↓
列表、状态、Todo、注意力视图
```

工具只在这套语言无法触及真实世界时出现，例如文件系统、终端和网络。Plan、Ask、Todo、Goal、Memory 并没有越过新的世界边界，所以它们应该留在 Markdown 和自然语言里。

最终可以把它浓缩成两句话：

> 对载体和不变量保持严格，对内容和工作方式保持开放。
>
> 让程序保证事实可靠，让自然语言智能决定事实意味着什么。

这正是早期 Iris“模糊优于精确、智能优于规范”的延续，而 Whiteboard 是它在内置 Agent 时代最自然的落点。

## 用户补充

我可以提示你一下，现在的issue状态机就是让AI直接填写的，而不是设计一个“状态转移工具” 继续调研

## Agent 回应

这个提示非常关键：Issue 状态机已经是这套哲学的一个成熟实例。状态约束由协议规定，但状态迁移不是一个专用 API；AI 直接编辑 Markdown frontmatter，应用再从文档投影状态。

这不是一个孤立例子，而是早期 Iris 全套设计的样板：Todo 是正文里的 GFM checkbox，workspace 由目录结构推断，label 词表从文档实际值归纳，状态规范写在 Prompt，状态事实直接写进 frontmatter。App 负责字面解析、可靠写入和视图投影，不负责替 AI 理解工作。

因此，Iris 的核心分工可以写成：

```text
Prompt 定义语义
AI 判断现实
Markdown 保存事实
App 确定性投影
```

Issue 状态机说明：状态机可以是一套关于文档字段的语言协议，而不必成为一个必须通过 API 操作的运行时对象。工具如果只是改一行 Markdown，却引入 Issue ID、状态服务、工具 schema、调用错误、文件同步和第二份事实源，就没有增加 Agent 接触世界的能力，只是把已有语言行为重新包装了一遍。

因此，对 Iris 而言：

- 对载体和不变量保持严格，对内容和工作方式保持开放；
- 硬编码字母表，不要硬编码句子；
- 让程序保证事实可靠，让自然语言智能决定事实意味着什么；
- 不要为 Agent 的每一种思维动作造一个按钮，给它纸和笔，告诉它必要的写作纪律，然后相信它会思考。

