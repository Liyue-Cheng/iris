---
title: 修复 Markdown 拖入图片后切换文档再返回时图片消失
status: Done
---

## 问题

用户报告：将图片拖入 Markdown 文档，当时能看到图片，但切换到其他文档再返回后图片消失。需确认是图片引用未保存、资源路径解析错误，还是编辑器重建时图片加载失败。

## 调查与修复计划

1. 检查拖入/上传、资源文件落盘、Markdown 序列化与切换前保存的完整链路。
2. 检查重新打开时富文本编辑器及预览的图片 URL 解析，复现根因后修复。
3. 添加相关回归测试，运行必要检查，将实现与验证结果追加到本 issue。

## 根因与复现（2026-10-22）

已检查现有文档中的相对图片引用及对应 `.assets/` 文件，二者仍在。真实 Milkdown 编辑器测试成功复现：程序插入图片节点时能显示，序列化为 Markdown 后销毁编辑器，再用相同 Markdown 创建编辑器，图片节点消失。

原因是 Markdown 图片没有可选标题时，Remark 将 `title` 解析为 `null`。Milkdown 的块级图片解析器直接把它赋给 `caption`，但节点 schema 要求字符串。ProseMirror 抛出 `Expected value of type string for attribute caption on type image-block, got null`；Milkdown 捕获并记录错误，继续解析其他节点，因此表现为图片直接消失。行内图片的 `title` 属性也存在同样的问题，已通过测试复现。

## 修复结果

- 新增 [图片 schema 配置](../../src/renderer/lib/markdown-image-schema.ts)，在块级、行内图片进入原有解析器前，将缺省的 `title` / `alt` 归一化为空字符串。保留已有 schema 校验、图片标题、缩放比例和序列化逻辑，不修改依赖包。
- 在 [CrepeEditor](../../src/renderer/components/doc/CrepeEditor.tsx) 创建编辑器时注册配置，适用于切换文档、切换编辑模式和重新打开。
- 已有相对路径仍按文档位置加载，DOM 使用的 data URL 不写回 Markdown。现有文档及图片文件未作修改。

## 验证证据

- 新增 [编辑器重开回归测试](../../src/renderer/lib/markdown-image-reopen.test.ts)：使用真实 Milkdown/ProseMirror/Vue 编辑器，在 DOM 测试环境中执行插入、序列化、销毁、重建及修改周围文字后再次序列化。无标题图片在修复前失败，修复后通过；同时覆盖带标题图片、缩放比例、块级/行内图片共存，以及本地相对路径不被 data URL 替换。
- [资源管理测试](../../src/main/asset-manager.test.ts) 覆盖导入图片、保存 Markdown 后重新读取，确认中文和空格路径经 URL 编码后仍能读回相同图片字节。
- `npm test -- src/renderer/lib/markdown-image-reopen.test.ts src/main/asset-manager.test.ts src/renderer/lib/editor-session.test.ts src/renderer/lib/editor-store.test.ts src/renderer/lib/crepe-lifecycle.test.ts`：5 个文件、26 项测试全部通过。
- `npm run typecheck`：Node、preload、Web 类型检查及异步边界检查全部通过。
- `git diff --check`：通过。

未运行打包、安装更新或开发服务器截图。DOM 回归测试验证节点和图片 URL 恢复，不代替 Electron 中的实际图片解码与鼠标拖放验收。

## 待人工验收

- [ ] 在包含修复的 Iris 版本中导入无标题图片，切到其他文档再返回，确认图片仍显示。
- [ ] 编辑图片周围的文字并保存，再重新打开，确认图片引用和图片本身保留。
- [ ] 切换源码/富文本模式，确认块级、行内以及带标题图片均正常显示。

## 0.1.1 构建验证（2026-10-22）

用户随后要求提升版本并编译。修复已包含在 Windows x64 `0.1.1` 安装版和便携版中，
`npm run dist -- --win --x64 --publish never` 成功。全量 108 个测试文件、694 项测试通过；
类型／异步边界、元数据、许可证及 Agent Worker 检查通过。
包内 1,883 个构建文件与输出一致，生产 renderer 已确认包含图片 schema 配置及注册调用。
打包归档在隔离配置下通过隐藏窗口启动检查，preload 和页面就绪并运行 5 秒。

产物、校验和及验证范围见[开发与构建记录](../status/开发与构建.md#2026-10-22-本地构建-011)。
尚未安装新版本或验收实际拖放与图片显示；保留 `In Review`，上方人工验收项仍待完成。

## 迁移到上游修复（2026-10-24，0.1.2）

按用户授权，将 Milkdown/Crepe/Kit 全套升级为 7.22.3。该版本已包含上游 PR #2478 的缺省图片标题修复，原 `markdown-image-schema.ts` 临时兼容层及其注册已移除。保留图片重开与资源持久化测试，直接验证上游行为；当前全量 110 个文件、704 项测试通过，完整类型检查通过。

生产页面及打包验证记录统一写入[当前迁移 issue](./2026-10-22-优化界面.md)。前文 0.1.1 使用兼容层的记录保留为历史。

## Markdown 全链路审查（2026-10-25）

用户反馈 Markdown 编辑器仍存在问题，要求全面检查代码逻辑及其他隐患。本轮先审查和验证，不以历史修复或测试通过作为当前无问题的依据。

审查范围：文档加载与异步会话、编辑与自动保存、文档/模式切换、外部文件变更、Markdown 解析与序列化、图片导入与 URL 解析、资源生命周期及失败处理。对发现区分已复现问题、代码可证实的风险和待人工确认项，追加具体代码位置与验证证据。

### 审查结论

当前工作树仍有内容丢失、状态覆盖和格式损坏的缺陷。上游 7.22.3 修复的是缺省图片标题解析，不能解决编辑器最新内容尚未同步到保存状态、异步保存回调污染新模式等问题。本轮发现一条能复现“图片已经插入，立即切走后未保存”的独立链路，但尚不能断定它就是用户本次现场问题的唯一原因。

本轮完成的是代码审查与复现，没有修改生产实现。`In Review` 表示审查结果待评审，不表示下面的缺陷已修复。检查基于当前源码（package.json 为 0.1.3），未确认用户正在运行的安装包与当前源码一致。

### 已复现：优先处理内容丢失与会话错误

#### F1 · P1：编辑器内容通知延迟，立即切换会漏存图片或最后一次输入

位置：[CrepeEditor.tsx](../../src/renderer/components/doc/CrepeEditor.tsx) 第 138、190 行；[editor-store.ts](../../src/renderer/stores/editor-store.ts) 第 363、408 行；依赖 `@milkdown/plugin-listener/src/index.ts` 的 `debouncedHandler`。

Milkdown 的 `markdownUpdated` 使用 200 ms 防抖，销毁时直接取消回调。Iris 只通过该回调同步正文；保存、切模式和卸载前都没有主动取出编辑器的最新 Markdown。图片节点可以已经显示，但 store 仍认为文档未修改，`flushBeforeSwitch()` 返回成功后便卸载编辑器。快速输入后切模式、进入设置、退出窗口也共享这一缺口；持续输入时通知还可能一直被延后。

真实 Crepe + editorStore 复现：插入 `./a.assets/image.png` 节点，`crepe.getMarkdown()` 已包含图片；立即执行离开前保存再销毁，允许离开，但 `doc.save` 调用次数为 **0**。这次测试覆盖真实编辑器事件，IPC 保存端使用 mock；没有模拟 Electron 鼠标拖放。

修复方向：保存、切换、退出和重挂载前统一同步活动编辑器快照，或通过同步事务维护最新草稿；不能只缩短防抖时间。图片异步上传中的等待/离开策略也应纳入同一边界。

#### F2 · P1：外部变更读取完成后，可能把 A 文档装进 B 的当前会话

位置：[editor-store.ts](../../src/renderer/stores/editor-store.ts) 第 427–441 行；[interrupts.ts](../../src/renderer/cpu/interrupts.ts) 的文件变更处理。

`handleDiskChange()` 只在 `await readDisk()` 前核验路径，读取完成后直接访问全局 session。复现：A 的外部读取挂起，切到 B，再返回 A 的内容，当前 session 被改回 A；如果期间关闭会话，则抛出 `Cannot read properties of null (reading 'baselineRaw')`。B 有草稿时还会把 A 的内容登记为 B 的冲突，后续“重新加载”可丢掉 B 草稿。

修复方向：读取前捕获项目、会话身份和请求序号，完成后重新核验；同文档多次外部读取也需要拒绝过期结果。仅依靠项目 scope 校验不能阻止同项目内的错文档问题。

#### F3 · P1：源码保存回调晚于模式切换，会使后续富文本编辑失去保存能力

位置：[editor-store.ts](../../src/renderer/stores/editor-store.ts) 的保存快照与回调；[editor-session.ts](../../src/renderer/lib/editor-session.ts) 第 109–153 行。

源码保存快照的 `bodyCurrent` 为 null。源码修改后开始保存，随后切到富文本并完成 hydration，若旧保存此时才返回，`advanceBaselineAfterSave()` / `rebaseAfterSave()` 会把富文本 `bodyBaseline` 置为 null。切换模式没有增加 revision，保存快照也没有记录对应模式/会话身份；之后 `updateWysiwygBody()` 因基线为 null 拒绝用户编辑。

复现结果：保存回调返回后写入 `later rich edit`，最终组合内容仍为 `source edit`。修复应把磁盘基线推进与当前编辑器的序列化基线分开，旧模式保存不能重置新模式状态。

#### F4 · P1：等待离开前保存期间产生的新编辑，仍会被允许丢弃

位置：[editor-store.ts](../../src/renderer/stores/editor-store.ts) 第 363–411 行。

`save()` 只提交调用瞬间的快照，队列排空后返回 saved，没有检查当前 revision 是否仍有未提交修改。复现：提交 `first` 并挂起写入，期间输入 `last`，完成第一次写入后，`flushBeforeSwitch()` 返回 true，但 session 仍为 dirty。实际离开会清除后续自动保存定时器或销毁会话。

修复方向：离开前保存需确认最新草稿已持久化，必要时重复提交或临时限制编辑；不能只检查某个旧快照是否写成功。此问题独立于 F1，复现时新输入已经进入 store。

#### F5 · P1：源码模式修改标题/状态后继续输入，会恢复旧元数据

位置：[SourceEditor.tsx](../../src/renderer/components/doc/SourceEditor.tsx) 第 31–51、82 行；[editor-store.ts](../../src/renderer/stores/editor-store.ts) 的 `applyFmBlock()`。

CodeMirror 仅在 mount 时读取 `text`；store 修改 frontmatter 不增加 generation，组件也没有把后续 text prop 同步回 CodeMirror。真实 React + CodeMirror 复现：标题栏把 `title: old` 改成 `title: new` 并完成保存，源码框仍持有旧标题；随后输入正文，整个旧缓冲区重新进入 store，标题又变成 old。

修复方向：对来自标题栏等外部状态变更做明确的 CodeMirror transaction，同步文本且避免回声、光标重置和撤销历史丢失。

#### F6 · P1：外部删除直接丢弃未保存草稿

位置：[editor-store.ts](../../src/renderer/stores/editor-store.ts) 第 440 行。

`handleDiskUnlink()` 无条件 closeSession，不检查 dirty、saving 或冲突。复现：创建 `unsaved draft` 草稿，发送对应 unlink，草稿立即变为 null。外部删除、重命名或未被 watcher 合并的删除后重建均可能进入该分支。这里测试的是收到 unlink 后的行为，不代表每次原子替换都会产生 unlink。

修复方向：将外部删除作为可恢复冲突处理，保留草稿并提供恢复/另存；确实由用户确认删除的流程可以另行明确处理。

#### F7 · P1：磁盘内容比较与替换之间仍会覆盖外部新写入

位置：[project-manager.ts](../../src/main/project-manager.ts) 第 346–374 行；[atomic-write.ts](../../src/main/atomic-write.ts)。

`writeDoc()` 在读出旧内容后比较 expectedContent，再异步写临时文件、fsync、rename。外部编辑器或 Agent 在比较完成后写入的新内容不会再被检测。真实临时文件复现，在最终 rename 前注入一次外部写入，保存最终成功，外部内容被 `local` 覆盖。原子 rename 保证文件完整，不等于原子的比较并交换。

修复方向：统一应用内部写入锁，在替换前再次验证外部版本，并保留可恢复的冲突内容。单纯再比较一次仍不能承诺对不协作的外部写入者实现绝对原子 CAS，应明确残余窗口和恢复策略。

### 已复现：内容保真与功能一致性

#### F8 · P2：只切换布局也会把原始 Markdown 改成规范化版本

位置：[editor-store.ts](../../src/renderer/stores/editor-store.ts) 第 282 行；[project-store.ts](../../src/renderer/stores/project-store.ts) 第 604、650 行。

`prepareForRemount()` 无条件用 bodyCurrent 替换 originalBody，绕过了“正文没有用户编辑时保留原始字节”的判断。复现：原文 `* item`，hydration 序列化为 `- item`，原本 dirty=false；准备重挂载后组合正文变为 `- item` 且 dirty=true。集合详情切到普通文档等路径会调用它，后续保存可产生无编辑的全文变更。修复应沿用 compose 的原文/草稿选择逻辑。

#### F9 · P2：块图片的 alt 文本在普通编辑后被替换为缩放比例

位置：依赖 `@milkdown/components/src/image-block/schema.ts` 第 38–63 行及其 remark 插件；Iris 启用了 ImageBlock。

真实 Crepe 复现：输入 `![architecture description](./diagram.png)`，只修改前面的文字，序列化变为 `![1.00](./diagram.png)`。上游把块图片 alt 当作 ratio，schema 没有保留独立 alt。原始文件刚打开时尚可由原文保留机制保护，但正文首次编辑或 F8 的布局切换会使该信息丢失。需要兼容普通 Markdown alt，并制定缩放信息的保留方式。

#### F10 · P2：图片导入接受的格式/大小，图片读取却拒绝

位置：[asset-manager.ts](../../src/main/asset-manager.ts) 第 210、382 行；[project-manager.ts](../../src/main/project-manager.ts) 第 255–285 行；[markdown-media.ts](../../src/renderer/lib/markdown-media.ts)。

复现：SVG 被成功导入并标记 kind=image，但读取返回 unsupported-type；10 MiB + 1 字节的 PNG 扩展名文件也成功导入，读取返回 too-large（此用例验证大小门槛，不验证 PNG 解码）。界面把不同错误统一转成失败图片 URL，用户难以知道是文件丢失、类型不支持还是超限。

SVG 禁止预览是已有安全策略，本轮不建议直接解除。应统一上传和预览能力，对不支持预览的文件按附件处理或提前说明，并显示具体读取失败原因。

#### F11 · P2：frontmatter 边界处理与损坏保护不完整

位置：[markdown-utils.ts](../../src/shared/markdown-utils.ts) 第 24、99 行；[TypedHeader.tsx](../../src/renderer/components/doc/TypedHeader.tsx) 第 183、334 行；[editor-session.ts](../../src/renderer/lib/editor-session.ts) 的初始化。

已复现三个独立边界：合法空块 `---\n---\n` 不被 splitFrontmatter 识别；`title:\nstatus: Todo` 的空标题会因 `\s*` 跨行被读取为 `status: Todo`；缺少结束分隔符的文档被识别为无 frontmatter，header 认为可编辑，改标题会在旧损坏块之前再插入一个新块。DocContent 的 frontmatterBroken 没有进入编辑会话，不能保护此路径。

修复方向：区分无 frontmatter、空块和损坏块，限制标量读取的空白匹配范围，并贯穿传递解析错误状态。不可把“没有匹配到完整块”直接当成“允许新增块”。

#### F12 · P2：导入附件生成的 Markdown 链接，在正文中无法打开

位置：[asset-actions.ts](../../src/renderer/lib/asset-actions.ts) 第 49 行；[markdown-navigation.ts](../../src/renderer/lib/markdown-navigation.ts) 第 64–70 行；[CrepeEditor.tsx](../../src/renderer/components/doc/CrepeEditor.tsx) 第 77 行。

附件导入生成 `[manual](./a.assets/manual.pdf)`，而链接解析器只接收相对 `.md` 路径；该 PDF 路径返回 invalid。正文点击一律 preventDefault，invalid 没有提示或后续动作，因此用户看到正常链接却打不开。附件面板的打开操作是另一条路径。应为项目内附件链接接入已有受控打开能力。

### 需要限定触发条件的风险与现有行为

- R1：AssetManager 的重名分配是“检查存在 → 写入”，没有原子占位。直接并发调用 8 次导入不同内容的 image.png，实际只返回 1 个唯一目标路径，发生覆盖。但正常单窗口 `asset.import` 有 FrontCPU 文档/资源写锁，不能把该底层复现等同于单窗口多选上传必现。跨窗口、绕过调度或超时后底层任务继续运行时仍需主进程防护；尚未做跨窗口端到端复现。
- R2：[asset-actions.ts](../../src/renderer/lib/asset-actions.ts) 第 19 行先 await file.arrayBuffer，再派发导入；项目 scope 到 IPC 执行时才读取。读取文件期间切项目，在另一个项目存在相同相对文档路径时，存在导入落到新项目的风险。此项为代码路径分析，尚未做完整切项目复现；应在读取前捕获 scope 并在派发/结果应用前核验。
- R3：Crepe 初始化后的几个动画帧仍可编辑，但正文更新被 bodyHydrating 丢弃，随后当前内容又被当作初始基线；初始化失败也仅 console.error，没有编辑器错误/重试界面。存在早期输入被当成规范化、或空白编辑器缺少恢复入口的风险；未进行 Electron 慢设备/输入法现场验证。
- 系统图片拖入的当前行为已经改变：[DocView.tsx](../../src/renderer/components/doc/DocView.tsx) 捕获文件 drop，[doc-drag.ts](../../src/renderer/lib/doc-drag.ts) 将所有系统文件（包括图片）转为路径文本；现有测试明确覆盖该策略。本轮将它记录为需求/入口差异，不擅自认定要恢复图片拖入。图片上传按钮、粘贴和拖路径必须分别验收，历史“拖入图片”的测试不能替代当前入口行为。
- HTML 使用 DOMPurify 白名单、Mermaid 使用 strict 模式；本轮没有以放宽 HTML/SVG/本地文件安全限制作为修复建议。原子写失败保留旧文件、普通同路径排队保存、已知列表/表格/代码块/图片重开等现有回归仍通过。

### 本轮验证证据与范围

现有相关回归：17 个测试文件、142 项全部通过。执行命令：

```powershell
npm test -- src/renderer/lib/editor-session.test.ts src/renderer/lib/editor-store.test.ts src/renderer/lib/crepe-lifecycle.test.ts src/renderer/lib/markdown-image-reopen.test.ts src/renderer/lib/markdown-content.test.ts src/renderer/lib/markdown-crepe.test.ts src/renderer/lib/stable-code-block.test.ts src/renderer/lib/safe-html.test.ts src/renderer/lib/mermaid-preview.test.ts src/renderer/lib/markdown-navigation.test.ts src/renderer/lib/doc-drag.test.ts src/renderer/lib/project-scope.test.ts src/renderer/lib/document-navigation-store.test.ts src/main/asset-manager.test.ts src/main/project-manager.test.ts src/main/atomic-write.test.ts src/shared/markdown-utils.test.ts
```

另编写并执行 2 个临时审查文件、17 项定向断言，按期望安全行为断言全部失败：renderer 13 项对应上述编辑器/解析问题，main 4 项对应磁盘并发窗口、两种不可预览导入及 R1 的底层并发限制。**这是缺陷复现结果，不是修复后通过的测试，也不表示存在 17 个互不相关的根因。** React/CodeMirror 用例补齐 jsdom 几何 API 后重新执行，最终结果没有依赖最初的几何 API 警告。

临时用例已移出默认测试目录，生产文件及原有测试未作修改。本机保留 `.git/markdown-audit-2026-10-25/renderer.test.ts`、`main.test.ts`、`results.json`，未纳入版本控制；后续复现可分别复制回 `src/renderer/lib/markdown-audit-temp.test.ts` 与 `src/main/markdown-audit-temp.test.ts` 后执行 `npm test -- src/renderer/lib/markdown-audit-temp.test.ts src/main/markdown-audit-temp.test.ts`。这些断言用于暴露缺陷，不能作为当前应全绿的正式测试直接合入。

本轮未运行 build/dist、开发服务器或截图；没有声称完成 Electron 图片解码、真实拖放、剪贴板、输入法、慢磁盘与跨窗口人工验收。工作树中已有设置/主题相关修改保持原样。

### 后续修复与验收清单

建议优先修复 F1–F7，再处理 F8–F12，并把临时复现转成正式回归。验收应覆盖“编辑器真实输入/事务 → 状态同步 → 保存 → 卸载 → 从磁盘重开”，不要只测试手动调用 getMarkdown 后重建。

- [ ] 评审本轮发现及优先级，并补充用户本次异常的具体操作与运行版本。
- [ ] F1：补齐保存/切换/退出前的编辑器最新快照同步，验收快速编辑与图片插入后立即离开。
- [ ] F2：外部读取结果按项目、会话与请求顺序隔离，验收 A/B 快速切换和关闭期间回调。
- [ ] F3：隔离旧模式保存回调，验收保存未完成时切模式后继续编辑。
- [ ] F4：离开前确认最新草稿已持久化，验收慢写入期间的后续输入。
- [ ] F5：同步源码编辑器的外部 frontmatter 变更，验收继续输入和撤销。
- [ ] F6：外部删除时保留脏草稿并提供恢复入口。
- [ ] F7：完善内部写入协调、外部变更检测与冲突恢复策略。
- [ ] F8：保持无编辑布局切换的原始字节不变。
- [ ] F9：保留普通 Markdown 图片 alt，同时兼容既有缩放信息。
- [ ] F10：统一图片导入/读取能力并显示具体失败原因。
- [ ] F11：修复空/损坏 frontmatter 与空值读取，补齐主进程和编辑器一致性验证。
- [ ] F12：为正文中的项目内附件链接提供受控打开行为。
- [ ] R1：验证跨窗口同名导入，评估主进程原子分配与写入协调。
- [ ] R2：验证大文件读取期间切项目，保证资源仍归属原始项目。
- [ ] R3：验证初始化期间输入和初始化失败后的恢复。
- [ ] 明确图片拖入与路径拖入的产品行为，并分别人工验收上传、粘贴、拖放入口。

## Markdown 编辑器重建与闪动专项审查（2026-10-25）

用户追加要求：检查 Markdown 导致代码提示框卸载后重新加载、页面闪动的问题，判断既有局部修复是否解决根因。本轮检查 React 编辑器挂载边界、Milkdown/ProseMirror NodeView 更新、CodeMirror 生命周期、预览与提示浮层，以及 store/watcher 对 generation 和布局的影响；先审查和复现，再记录根因层级及修复方向。

用户随后明确范围为 **Markdown 中的代码块或 Mermaid 预览区域**。本轮没有修改生产实现，审查完成后恢复 `In Review`，以下修复仍待实施。

### 专项结论：上层整篇重建和下层过期预览都还存在

已定位两层独立问题：

1. **同一文档的内容更新被当作编辑器生命周期变化。** 外部只改标题、甚至只改代码块以外的一段文字，都会增加 generation，销毁整篇 Crepe 以及全部代码块。之前“禁止离屏销毁”的适配无法阻止父编辑器主动销毁。
2. **Mermaid 渲染结果没有归属当前代码块版本的校验。** NodeView 可以完全没销毁，但过期结果仍会替换当前 SVG；甚至切成普通文本代码后，旧图仍能回来并重新隐藏代码区。这是另一种看起来像重新加载的跳变。

同时确认存在放大视觉跳变的过程：每次全量重建都会重新经历代码占位 → 加载文案 → 图表，缺少上次图表/高度的复用。DOM 测试已验证这些状态转换；实际闪动幅度与滚动位移没有用 jsdom 冒充浏览器布局测量。

### L1 · P1：外部非代码变更仍然销毁代码块和预览

调用链：

```text
文件变更 → handleDiskChange()
  → 当前无草稿：openSession(content)
  → 同路径 generation + 1
  → CrepeEditor useEffect 清理旧实例，再创建新实例
  → CodeMirrorBlock.destroy() / Vue app.unmount() / CodeMirror.destroy()
  → 新代码块占位 → IntersectionObserver 首次初始化 → Mermaid 再渲染
```

代码位置：[editor-store.ts](../../src/renderer/stores/editor-store.ts) 第 257–259、427–436 行；[CrepeEditor.tsx](../../src/renderer/components/doc/CrepeEditor.tsx) 第 69–207 行；依赖 `@milkdown/components/src/code-block/view/node-view.ts` 的 destroy。

使用真实 React `CrepeEditor`、真实 editorStore、Milkdown NodeView、CodeMirror 和 Vue 预览组件复现，Mermaid 渲染器使用可控 mock 统计调用与返回顺序：

| 操作（同一篇文档） | 代码块 destroy 次数 | Mermaid 累计渲染次数 | 结果 |
| --- | ---: | ---: | --- |
| 首次打开并完成预览 | 0 | 1 | 初始实例 |
| 外部仅修改 frontmatter 的 title | 1 | 2 | 正文完全没变仍全量重建 |
| 外部仅修改代码块后的普通段落（独立用例） | 1 | 2 | 未变代码块也被销毁 |

因此，Agent 连续写入文档时，即使代码块本身不变，也能持续触发相同的销毁/重载链路。此处复现的是向 store 注入读盘结果后的真实组件生命周期，未启动文件 watcher 做端到端文件事件测试。外部变更与本地草稿冲突时，当前逻辑会保留冲突而不立即重建；上表针对 clean 会话。

### L2 · P1：Mermaid 旧结果污染当前预览，节点未卸载也会跳变

代码位置：[mermaid-preview.ts](../../src/renderer/lib/mermaid-preview.ts) 第 8–46 行；依赖 `code-block/view/components/code-block.tsx` 第 89–108 行和 `preview-panel.tsx` 第 85–99 行。

每次代码内容或语言变化，Vue watch 都调用 renderPreview。当前 Mermaid 函数每次启动异步 render，完成或失败就直接 applyPreview；`renderSequence` 只用于生成 SVG ID，没有判定“这还是当前代码块的当前请求”。上游 PreviewPanel 收到新值后清空旧内容，并用 innerHTML 安装清洗后的新内容。

复现了两个情形，期间 **CodeMirrorBlock.destroy 次数均为 0，NodeView 身份保持不变**：

- 图表由版本 1 连续改到 2、3，版本 3 已成为当前源码；此时版本 2 完成，页面仍安装了 `obsolete version 2`，之后再替换为版本 3。用例按照请求顺序完成结果，不依赖 Mermaid 乱序返回。即便依赖内部串行执行，过时中间结果仍可能逐个刷到页面。
- Mermaid 的首次渲染挂起时，把代码语言改为 text，预览正常消失；随后旧 Mermaid 请求完成，旧图又被安装，`previewOnlyByDefault: true` 使代码区重新隐藏。此时语言与显示内容不一致。

这说明仅保留 CodeMirror 实例不足以稳定预览。取消旧请求或至少拒绝其结果，需要以 **NodeView 实例 + 内容/语言版本 + disposed 状态** 为依据。不能仅在 renderMermaidPreview 内按 applyPreview 函数对象缓存：上游 watch 每次传入新的箭头函数，函数身份不是稳定的代码块身份。切出 mermaid 语言和销毁节点时也必须使旧请求失效。

### L3 · P2：首次装载的占位高度与预览结果没有连续性保障

代码位置：依赖 `code-block/view/node-view.ts` 的 renderPlaceholder / initializeCodeMirror，`code-block/view/components/code-block.tsx` 的 async preview 分支；[CrepeEditor.tsx](../../src/renderer/components/doc/CrepeEditor.tsx) 的 previewOnlyByDefault 与 previewLoading；[scroll-memory.ts](../../src/renderer/lib/scroll-memory.ts)。

真实组件测试观察到：

1. IntersectionObserver 尚未触发时，区域是显示 Mermaid 源码的 `.milkdown-code-block-placeholder`，没有预览。
2. 首次进入视口后删除占位，挂载 CodeMirror/Vue；代码区隐藏，预览显示 `editor.rendering`。
3. 异步完成后加载文案被 SVG 替换。

本地样式没有为这三个阶段保存上一版图表的高度；每次 L1 重建都会重走此过程，Mermaid 也没有按相同内容复用已完成结果。滚动记忆按像素恢复，最多等待 18 帧且高度连续稳定几帧即结束；更晚完成的图片/图表布局变化仍不在恢复窗口内。以上为状态序列复现与代码分析，没有测量真实布局位移。

修复方向是优先避免不必要重建，再在确需重建或首次渲染时保持占位/图表区域的几何连续性。重复更新已有图表时，上游本来会保留非空旧预览直到回调，因此不能笼统宣称“每次输入都先清空成 loading”；已确认的问题是旧版本结果无过滤地替换、以及重新挂载时回到完整加载流程。

### 既有修复的有效范围与排除项

[stable-code-block.ts](../../src/renderer/lib/stable-code-block.ts) 当前做两件事：覆盖实例私有 scheduleTeardown，阻止离屏 5 秒后销毁；限制传给 CodeMirror 的选区范围。它没有改变 editorStore.openSession、Crepe effect 依赖或 Mermaid 预览提交机制。

补充对照测试确认：普通段落本地编辑 → 保存 → 标题栏本地改标题 → 自身保存的 watcher 回声，以及已初始化代码块离屏 5.1 秒后返回，均保留同一个 NodeView、同一个 CodeMirror、同一个实际 `.preview svg`，destroy=0，Mermaid 渲染次数仍为 1。这说明离屏保留修复确实有效，正常本地输入/保存并非必然触发全量重建。

另外检查了这些边界：

- 普通 store emit / React rerender 不自动重建 Crepe，body prop 不在创建 effect 的依赖中，DocView 传入的 adapter 回调也稳定。不能把“React 重渲染”直接等同于“编辑器卸载”。
- 当前 PaneFrame 的 cards/layered 变化保持相同元素树，仅更换样式；没有证据将纯配色或该样式变化列为重建根因。相关文件已有用户未提交修改，本轮未改动。
- 同一文档从集合详情进入普通布局，`prepareForRemount()` 加 generation，且 DocView 所在 React 树位置发生变化；这里仍会重建。打开设置替换 ThreePane，关闭后重建；locale、BlockEdit 变化也在 Crepe 创建 effect 的依赖中。这些是源码确认的生命周期边界，本轮未逐一做完整 shell 挂载测试。
- `mountCrepeSerially()` 保证同一 DOM root 上 create/destroy 顺序正确，解决并发实例竞争；它不保留实例、预览缓存或旧 DOM，因此不是视觉连续性方案。
- NodeView 没写自定义 ignoreMutation 不等于 DOM 修改会无限重建：ProseMirror 对无 contentDOM 的 NodeView 默认忽略非 selection 的内部 DOM mutation，本轮没有证据需要靠“全部忽略 mutation”修复。

### 建议的根本修复方案（本轮未实施）

应把三种身份分开：文档/编辑会话身份决定何时销毁 Crepe；文档内容版本决定如何向现存编辑器应用变更；代码块预览版本决定哪个异步结果可以提交。

1. **同文档更新保持 editor runtime。** Frontmatter-only 外部变更只更新 header、磁盘基线与冲突状态，不触碰正文实例。外部正文变化通过已存在的 ProseMirror EditorView 做受控差异 transaction，尽量保留未变化的节点；不能简单把“销毁重建”换成每次全文替换而不检查 NodeView 身份。应用前先同步未交付的本地输入，与前文 F1/F2 一并解决；选区映射、撤销边界和外部冲突策略必须明确。
2. **每个代码块有预览请求控制器。** 内容/语言变化合并调度，记录最新版本；只让当前有效版本更新 preview。语言切换与 dispose 会使旧结果失效；可取消的任务取消，不能取消的完成后丢弃。保留上一张有效图直到新结果准备好，避免把每个中间版本安装到 DOM。
3. **预览结果可复用且有容量上限。** 使用内容、语言、影响结果的 Mermaid 配置作为缓存键，复用相同输入的安全渲染结果；节点重建时能直接恢复而非重新显示 loading。缓存需要处理 SVG ID 唯一性、实例内交互绑定、配置失效和内存上限，不能简单缓存一个被多处搬动的 HTMLElement。
4. **让首次渲染和布局切换保持视觉连续。** 对确需重建的场景保存图表尺寸或稳定占位；长文档按阅读锚点恢复位置，并响应较晚完成的媒体布局。若要求同文档跨布局也零重建，需要稳定其 React 挂载位置；仅修改 CSS 动画、延长销毁时间或隐藏 loading 无法消除 L1/L2。
5. **把生命周期当成回归指标。** 除了文本/SVG 内容正确，还断言节点身份、CodeMirror destroy 次数、Mermaid 调用次数、过期结果没有安装、切语言后没有旧预览复活。正式测试应包含真实 React → Milkdown → CodeMirror/Vue 的集成路径；性能与布局位移另在实际 Electron 中验收。

### 专项验证记录

- 原有相关回归：`npm test -- src/renderer/lib/stable-code-block.test.ts src/renderer/lib/mermaid-preview.test.ts src/renderer/lib/crepe-lifecycle.test.ts src/renderer/lib/markdown-crepe.test.ts src/renderer/lib/editor-store.test.ts src/renderer/lib/project-scope.test.ts`，6 文件、56 项通过。
- 新增临时集成审查：6 项中 2 项对照通过、4 项按期望行为断言失败，分别证明 L1 的两种不必要重建和 L2 的两种过期结果问题。不是生产修复后的测试结果。
- 使用真实 React CrepeEditor、editorStore、Milkdown/ProseMirror、CodeMirror 和 Vue PreviewPanel；IntersectionObserver 事件人工驱动，Mermaid mock 提供可控 SVG/异步完成时机。因此验证的是生命周期和结果提交逻辑，未验证 Mermaid 真正计算图形时的帧率、耗时与像素闪动。
- 临时脚本已移出默认测试目录。本机留存 `.git/markdown-audit-2026-10-25/lifecycle.test.ts` 和 `lifecycle-results.json`；复制脚本回 `src/renderer/lib/markdown-lifecycle-audit-temp.test.ts` 后可用 `npm test -- src/renderer/lib/markdown-lifecycle-audit-temp.test.ts` 复现。未修改生产代码或原有测试，未运行打包、开发服务器或截图。

### 专项后续任务

- [ ] 评审上述生命周期拆分方案与本次现场触发动作的对应关系。
- [ ] 同文档外部 metadata-only 更新不重建正文实例。
- [ ] 同文档外部正文更新采用安全差异应用，保留未变化代码块并处理选区、撤销和冲突。
- [ ] Mermaid 预览建立每节点版本/销毁保护，拒绝过期成功和失败结果。
- [ ] 合并连续预览请求，并实现有容量上限且 SVG ID 安全的结果缓存。
- [ ] 为必要重建/首次加载提供稳定占位和阅读锚点恢复。
- [ ] 将 4 项缺陷复现及 2 项对照转成正式集成回归。
- [ ] 在 Electron 中验收 Agent 连续改文档、只改标题/普通段落、连续改 Mermaid、切语言、滚动进出视口和同文档布局切换，记录实际闪动/滚动位移。
