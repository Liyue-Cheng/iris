---
title: iris agent第二阶段开发
status: In Review
---
你看看最近所有关于Iris agent的issue，看看进度怎么样，最近都做了什么，然后下一步的重点是什么

## 进度盘点（2026-08-17）

### 总体判断

Iris Agent 已经越过“技术调研”和“只有 UI 骨架”的阶段。当前代码具备单 Issue、单
Session 的真实 Agent loop、main-owned 工具执行、持久化历史、Stop/Retry/Undo、Worker
恢复和 provider context artifact；最近两天又把最危险的会话一致性问题收口到 schema v3、
protocol v3 和唯一生产 domain reducer。

但它还不能被判断为“第二阶段完成”或“达到自举准入”。准确位置是：

* 第一阶段 Pi/运行时验证已经完成；

* 第二阶段 MVP 的代码骨架和主要单 Session 语义已经完成；

* 第二阶段真实产品闭环仍未验收，首轮 A-G 手工流程没有完整跑完；

* 第三阶段只提前完成了 provider context、命令串行化和单 Turn Undo 等底层基础，多
  Session/Fork、长命令 Terminal、文件 Rewind、多 Provider 和完整 Inspector 仍未完成。

因此，当前最需要的不是继续扩大功能面，而是先把“源码正确”推进为“当前真实产品入口可
重复通过”。最近发现的 ready 竞态、Stop 误结算、历史未恢复、orphan tool result 和 Rewind
多删一轮，都是自动化一度全绿后由真实使用发现的，说明这个门禁不能再跳过。

### 相关 Issue 现状

| Issue                              | 当前状态        | 已确认进展                                                                                                | 尚未闭环                                                                                              |
| ---------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `2026-08-06-Pi-agent调研`            | Done        | 完成 Pi 工程化评估，形成最初的终端级支持结论                                                                             | 其“不做 SDK 深度集成”结论已被 8 月 13 日的新产品决策取代，只作为历史前置材料                                                     |
| `2026-08-09-pi-agent`              | Done        | 完成 Pi 安装、版本和登录配置前置验证                                                                                 | 不代表内置 Iris Agent 产品能力                                                                             |
| `2026-08-13-Iris-Agent产品设计与开发`     | In Progress | 第一阶段全部勾选；第二阶段 Worker、IPC、store、ToolHost、右栏 UI、短命令和基础 Rewind 已落地                                      | 真实 provider 闭环、真实 diff/命令结果、watcher 写回和第二阶段退出条件仍未勾选；第三阶段主体未开始                                     |
| `2026-08-13-第一轮手工测试流程`             | Blocked     | 已通过真实使用发现并推动修复 watcher、Worker ready、历史排序、Stop/恢复等问题                                                  | A-G 流程没有从当前代码重新完整执行；文档仍保留多个已经由后续代码修复但尚未现场复验的失败项                                                   |
| `2026-08-13-Git-watcher无界监听导致项目卡死` | In Progress | 有界 Git 元数据监听与 Git 状态指纹探测已在工作树实现，并有专项测试                                                               | 代码当前尚未提交；Electron 43 下 handle、CPU、ignored storm 和 Agent 入口仍需人工验收                                  |
| `2026-08-13-Electron-43升级后风险检查`    | Todo        | Electron 43.4.0 安装、自动化、基础 smoke 和 Pi 运行时基线已经通过                                                       | 编辑器、PTY、外部 Agent CLI、安装产物和性能等人工兼容性检查未完成；这是发布风险线，不再阻塞 Pi 基础开发                                      |
| `2026-08-15-isir-agent-测试issue`    | Todo        | 仅提供测试 token/锚点                                                                                       | 不是功能进度记录，后续不应把它计入开发完成度                                                                            |
| `2026-08-16-iris-agent-可观测性`       | In Review   | 卡片入口和 app-owned artifact 已实现                                                                         | 原实现只保存 assembled input；后续已在 Stop/history Issue 中升级为 provider context bundle，但本 Issue 的说明和手工验收尚未同步 |
| `2026-08-16-Iris-Agent-Stop与上下文恢复` | Done        | Stop 单次结算、canonical history 注入、provider context、脱敏、Worker 重建和协议安全投影均已实现                              | 文档仍有真实入口复测、artifact 清理策略和更宽并发矩阵等待验证；`Done` 是用户状态决定，不等于这些门禁已有证据                                    |
| `2026-08-17-iris-阿根廷`              | Done        | 完成 canonical Session domain、schema v3、protocol v3、revision/epoch、单 Turn Undo、Retry 前缀替换和 artifact GC | 精确的 Stop/继续/Stop/Undo、重启恢复和 context identity 产品矩阵仍以 checkbox 保留                                   |

### 最近实际完成的工作

8 月 13 日的 `68b50aa` 建立了 MVP Session loop：Iris Agent 成为独立右栏 Session kind，
Session manager/store、Worker、ToolHost、IPC、Renderer 状态和交互入口一次接通。所有文件和
终端副作用回到 main，Worker 不直接操作工作区；历史保存在 app-owned `userData`，不污染项目
`.iris/`。

随后手工测试推动了三轮修复：首个 `run` 必须等待 Worker `ready`；Renderer 的一轮历史按
“用户消息 -> 工具事件 -> 最终回答”展示；Stop intent、终态结算和跨 Worker 历史恢复改为可验证
的 canonical 流程。所谓“完整提示词”也从本轮 assembled input 改成在 provider 边界捕获、经过
allowlist 和凭据脱敏的结构化 context bundle。

8 月 17 日的 `f7d3db5` 和 `d49187d` 是目前最重要的一次收口：会话升级到 schema v3，生产逻辑
统一到 Session/Turn domain reducer；Send、Stop、Retry、Undo、Close 使用
`commandId + expectedRevision` 串行提交；Worker 事件使用 epoch 隔离；Undo 每次只移除 timeline
末尾一个 terminal Turn；Retry 从被停止/失败 Turn 之前的前缀开始新 attempt；provider artifact
携带 app、protocol、Session revision 和 Worker epoch 身份。`1119072` 将结果写回 Issue。

本次盘点在当前工作树重新验证：`npm run typecheck` 通过；Iris Agent 相关 11 个测试文件、62 项
测试全部通过。未运行 build、dist，也未启动开发服务器。仓库 `HEAD` 为 `1119072`；当前另有用户
未提交的 Git watcher 代码和文档改动，本次没有修改或覆盖它们。

### 关键缺口

第一类是验收债务。产品总 Issue、手工测试 Issue、可观测性 Issue 和两个已标记 Done 的可靠性
Issue 之间存在状态与 checkbox 不一致。代码变更有很强的自动化证据，但当前 app/Worker 产物、
协议身份和真实 provider 路径还没有在一套连续矩阵中被共同证明。

第二类是产品可观察性还只有底层事实，没有完整工作面。provider context bundle 已存在，但用户
仍缺少集中检查 prompt 各层、历史、工具 schema、裁剪、usage、错误链、diff、命令结果和真实
Terminal correlation 的 Context Inspector。

第三类是关键里程碑二的主体功能尚未建设：同一 Issue 的多 Session 和 Fork、可交互长命令
Terminal 与隔离监督、对话和受管文件的完整 Rewind、OpenAI-compatible 多 Provider。当前“撤销
上一轮”只改变对话 timeline，并明确不回滚外部副作用，不能与未来的文件 Rewind 混为一谈。

### 下一步重点与顺序

P0 是关闭当前真实入口的正确性门禁。在这一步完成前，不建议并行铺开多 Session 或完整文件
Rewind，否则会在尚未稳定的会话语义上继续增加状态空间。

* [x] 完成并提交 Git watcher 有界化修复，在 Electron 43 / Windows 上记录 5,000 个 ignored 子目录场景的 handle、CPU、刷新延迟和 ignored storm 结果，确认 Iris Agent 空状态入口可交互。

* [x] 用带 app version、protocol v3、Session revision 和 Worker epoch 的当前运行入口，执行固定矩阵：首次 Send、工具调用、Stop -> 继续、Stop -> Retry、连续两个 stopped Turn -> Undo 一次、Worker 空闲重建、应用重启、Undo 后重启再 Send。

* [x] 在上述矩阵中打开 provider context，核对历史 user/assistant partial、合法 tool call/result 配对、当前请求和 identity；确认不再出现 `tool`/`tool_calls` 400，也不会恢复已 Undo 的 Turn。

* [x] 从头恢复 `2026-08-13-第一轮手工测试流程` 的 A-G 用例，把当前结果逐项写回；已由后续实现修复的旧失败必须以新现场证据关闭，不能只引用单测。

* [x] 根据复测结果同步产品总 Issue、可观测性 Issue 和相关 checkbox；只在真实证据覆盖后更新完成项，Issue 是否转 `Done` 仍由用户决定。

P1 是把已存在的可信性基础做成用户真正能用的观察面。这是进入复杂功能之前最有价值的一步，
因为后续 Fork、长命令和文件 Rewind 都需要用同一套事实定位问题。

* [x] ~~设计并实现最小 Context Inspector：同屏呈现实际 provider context、层级/fingerprint、历史与裁剪、工具 schema、provider/model、request 状态、usage、错误链和 correlation identity。~~（停止：等待新的产品定义。）

* [x] ~~从紧凑工具事件打通真实参数、结果、错误、文件 diff、命令完整输出和对应 Terminal；确保 Renderer 只消费受控标识，不接受任意本机路径。~~（停止：等待新的产品定义。）

* [ ] 为 context artifact 的保留期限、逻辑删除、失败重试和 GC 建立明确策略及测试，补齐 Undo 后隐私和磁盘生命周期。

P2 再进入关键里程碑二的功能建设，建议按依赖顺序推进：多 Session/Fork先建立用户可控的并行
路径；Agent Terminal/长命令再补齐真实工程执行；文件 Rewind建立在稳定 effect ledger 和冲突预检
上；最后扩展多 Provider，避免把 provider 差异混入会话模型收口。

* [x] ~~实现同一 Issue 下多 Session 的新建、切换、命名、结束、归档和重启恢复，再实现只复制 canonical 历史前缀与 anchor 的显式 Fork。~~（停止：等待新的产品定义。）

* [x] ~~实现 Agent 内部真实 Terminal 工作面、3 秒显示规则、完整输出重放、交互输入和 20 秒隔离监督，同时保持主 Agent loop 严格同步。~~（停止：等待新的产品定义。）

* [x] ~~在现有对话 Undo 之外单独实现“Rewind 对话和文件”：先做 revision 冲突预检、反向原子恢复、失败状态和不可回滚副作用说明。~~（停止：等待新的产品定义。）

* [x] ~~在单 Provider 的端到端门禁稳定后，补齐 OpenAI-compatible provider 枚举、模型选择、capability/error 和 adapter contract tests。~~（停止：等待新的产品定义。）

### 阶段完成口径

第二阶段可以结束的最小口径不是“相关单测全绿”，而是同一个真实 Issue 在当前可核验版本上完成
“读 Issue -> 读代码 -> 修改 -> 短测试 -> 写回 Issue -> 最终回答”，用户可以打开真实 diff、命令
结果和 provider context，watcher 正常刷新，普通 PTY 与外部 Agent CLI 没有回归。达到这个口径后，
再进入上述 P1/P2，并继续保持“任何自举都由用户在关键里程碑二最后确认”的现有边界。

## 方向调整：只收技术底座（2026-08-17）

用户决定后续产品重新定义。上文依赖旧产品方案的 Context Inspector、多 Session/Fork、Agent
Terminal、文件 Rewind和多 Provider 停止执行；对应 checkbox 已按“停止”结算，不表示功能已经
完成。当前只处理无论未来产品如何定义都必须成立的安全性、持久化、并发和运行时基础。

### 结论

现有 Agent domain、schema v3、protocol v3、Stop/Retry/Undo 和 provider history 不需要再重写。
当前还剩四组必要技术工作，其中前两组包含源码层面的明确缺口，不只是补测试。

### P0：工具执行安全边界

`src/main/agent/tool-host.ts` 的路径检查目前只在“目标本身是符号链接”时读取目标 realpath。
若项目内普通路径经过一个指向项目外部的符号链接或 junction 父目录，`readFile`/`access` 仍可能
穿出项目根；现有测试也没有覆盖这个场景。写入路径虽然检查了 parent realpath，但读取、访问和
terminal cwd 应使用同一套 canonical containment 规则。

终端工具的 `sanitizeEnv()` 目前不是脱敏函数：无论模型是否传 env，最终都会合并完整
`process.env`。这意味着模型控制的命令可以读取 main 进程中的 token、API key、credential 或其他
宿主秘密。provider context artifact 的脱敏不能补救已经进入工具输出或 provider 对话的秘密。

* [ ] 把 ToolHost 路径授权收口为统一 canonical-path helper：校验目标或最近存在父目录的 realpath，覆盖中间 symlink、Windows junction、大小写和不存在的新文件，确保 read/access/write/terminal cwd 都不能越出 project root。

* [ ] 增加项目内 symlink/junction 指向项目外的 read、access、write 和 terminal cwd 负向测试，同时保留项目内合法 symlink 的明确策略。

* [ ] 将 Agent terminal 环境改为最小 allowlist，并显式删除 token、key、secret、password、authorization、credential、Electron 私有变量和 Iris 上下文变量；模型传入 env 也必须经过同一策略，不能重新注入被禁止名称。

* [ ] 增加环境泄漏测试：在父进程放入伪 credential，执行 Agent terminal 后断言子进程不可见，且命令输出、Session history 和 provider context 均不包含该值。

### P0：持久化与命令提交点

`closeSessionNow()` 当前执行 `store.delete()` 后立即广播 `sessionDestroyed`，没有等待
`store.flush()`。进程在 150 ms debounce 窗口内退出时，已关闭 Session 可以在重启后复活。这与
Rewind 已经建立的“持久化成功后才对 Renderer 宣告成功”原则不一致。

另外，Windows 全量测试多次出现原子 `rename EPERM`。当前 `writeFileAtomic()` 对 replace 没有任何
短暂占用重试，虽然失败不会破坏旧文件，但会让 Session、设置和 artifact 写入产生可见失败。这个
问题已经不是纯测试噪声，因为生产路径共用同一 helper。

* [ ] 让 Close Session 在 `flush()` 成功后再广播销毁并返回；增加“删除后立即模拟进程重启”的恢复测试，以及 flush 失败时 UI 不得收到成功的测试。

* [ ] 为 Session 状态提交、provider context index 提交和 artifact GC 注入 write/rename/delete 失败，验证旧状态可恢复、逻辑 Undo 不反弹、cleanup pending 可重试且不会伪造 artifact 可用性。

* [ ] 为 Windows `EPERM`/`EBUSY` 设计仅作用于原子 replace 的有界重试与退避，保持唯一 temp 所有权、旧目标不损坏和最终失败可见；用确定性故障注入测试替代依赖偶发复现。

* [ ] 补齐 schema v1/v2 -> v3、损坏主文件 + backup、未知字段和部分 artifact 的兼容矩阵，确认迁移幂等且不会把损坏历史伪造成合法 provider 序列。

### P1：生命周期和竞态证明

当前自动化已经覆盖双 Send、Stop 事件乱序、连续 stopped Turn 的单次 Undo、Rewind 与 Send 串行、
Worker ready 校验和启动中 shutdown。仍缺少 ToolHost 正在执行时的 Stop/Close/项目切换、cleanup
失败、Worker crash 与晚到 tool/provider event 的 manager 级组合测试。

Worker 事件处理还依赖 manager-wide 可变 `currentScope`。当前每窗口只有一个 manager，项目切换也
先关闭旧项目，因此正常流程可以成立；但正确性依赖调用顺序，没有由类型或 host identity 直接保证。
技术上应让每个 host/event chain 绑定创建时的 project root/generation，或用测试完整证明切换期间
绝不会把旧事件路由到新 store。

* [ ] 增加 in-flight tool 矩阵：Stop、Close Session、Close Project、window shutdown、Worker crash 分别发生在 tool 开始前、执行中和结果返回后，断言副作用事实、tool 终态、Worker 回包和 Session 终态一致。

* [ ] 增加旧 Worker 的 late tool-result、provider-context、failure、state 与新 Worker epoch/新 project scope 交错测试，确认所有旧事件无副作用。

* [ ] 消除 Worker 事件对全局 `currentScope` 的隐式依赖，优先把 scope/store identity 固定到 host；若暂不改结构，至少建立真实 manager 的 project-switch 集成测试，而不是只 mock `closeProject()`。

* [ ] 覆盖 Close、Stop、Retry、Undo 和项目切换的 flush/terminate/post 不同完成顺序，确保每个用户命令只有一个可验证的完成点。

### P1：Git watcher 与运行时基线

Git watcher 有界化已在当前工作树实现，但 `src/main/git-manager.ts` 和测试仍未提交；这是打开大型
项目和 Agent 入口稳定性的共同前置。它应独立完成 review、自动化和 Windows 资源测量，不再与 Agent
产品功能混做。

本次重新运行 `npm run agent:worker-check` 已通过：Electron Node `24.18.1`、Pi `0.84.1`、protocol
v3；CI 也已经包含该 probe。因此 Worker 产物身份当前没有新的代码缺口，只需保持为每次协议或 Pi
升级的强制门禁。

* [ ] 完成 Git watcher 当前改动的 review、定向测试和提交，确认没有覆盖工作树中的其他用户改动。

* [ ] 在 Electron 43 / Windows 上测量大型 ignored 目录的 handle、CPU、probe 频率、刷新延迟和长期释放，确认结果满足有界契约。

* [ ] 在上述修复完成后运行一次不依赖未来 UI 定义的最小 runtime contract：真实 provider Send、Stop、Retry、Undo、Worker 重建和应用重启，并核对 protocol/revision/epoch/provider payload 身份一致。

### 可以暂时不做

在新产品定义出现前，不需要继续实现多 Session、Fork、长命令工作面、文件回滚、Provider 选择、
Context Inspector 或发布级 UX；也不需要再次重构 Session domain。技术收尾的完成口径是：上述安全
逃逸被封死，所有破坏性命令有 durable commit point，生命周期竞态有 manager 级证据，Git watcher
资源有界，当前 protocol v3 在真实 runtime 中可恢复。完成这些之后，底座就可以等待新的产品定义。
