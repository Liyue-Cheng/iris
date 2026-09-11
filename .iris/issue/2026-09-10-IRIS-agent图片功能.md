---
title: IRIS agent图片功能
status: In Review
---
目前好像不支持图片的上传和生成，你研究一下是怎么回事，要是需要支持，要改多少

---

## 现状核查报告（2026-09-10）

> 结论固定到工作树提交 `c67d665`，引用行号以该提交为准。上游能力核对的是
> `@earendil-works/pi-ai@0.84.1` 的 `dist/*.d.ts` 与内置模型表。

### 一句话结论

- **文档侧的图片功能是完整的**：Crepe 上传/粘贴/拖入、受管 `.assets/` 资产、渲染、
  健康状态、随文档聚合删除都已实现。本次不需要动这一块。
- **Iris Agent 侧没有任何图片能力**，而且不是“UI 还没做”：从输入框、IPC、会话模型、
  历史投影、Worker 协议、模型调用一直到工具结果，“文本”是**写进类型与运行时校验器**的，
  所以图片会在六七个地方同时断掉，不能靠加一个按钮解决。
- **图片生成（让模型出图）在 Iris 里完全不存在**：provider 配置只有两种 chat API，
  全仓库没有任何 `generateImages` 调用点。
- **但上游依赖已经具备能力**：pi-ai 0.84.1 同时提供多模态 message content
  （`ImageContent`）和独立的图片生成 API（`generateImages`，内置模型全部走
  `openrouter-images`）。缺的是 Iris 的接入层，不是依赖能力。
- **改动量**：图片输入（用户传图给 Agent 看）最小可用约 900–1300 行（含测试），
  需要协议 v15→v16 的破坏性升级；“Agent 读项目里的图”是它的顺带增量（+150–250 行）；
  “Agent 生成图片”是另一条独立链路，约 1000–1500 行，且会引入一个新的概念
  ——图片 provider profile，以及相应的设置页。

### 1. 先说清楚：文档侧图片功能已经能用

| 能力 | 位置 |
| --- | --- |
| 图片块上传按钮、粘贴、拖入统一落盘 | `src/renderer/components/doc/CrepeEditor.tsx:118-125`（`Crepe.Feature.ImageBlock.onUpload` → `importAsset`），`:160` |
| 受管资产（内容哈希命名、10 MiB 上限、签名嗅探、拒绝 SVG/符号链接） | `src/main/asset-manager.ts`（`importAsset`、`detectImage`、`MAX_IMAGE_BYTES`） |
| 正文渲染本地图片（相对路径 → 安全 dataUrl） | `src/renderer/lib/markdown-media.ts`（`DOC_IMAGE_READ`）、`src/main/ipc.ts` 的 doc image 处理 |
| 资产面板：四种健康状态、收编旧 data URL、孤儿清理、复制 Markdown 链接 | `src/renderer/components/doc/AssetPanel.tsx` |

结论：issue 里说的“不支持图片”**不适用于文档**。缺的是 Agent（对话与工具）这条链路。

### 2. Agent 侧：从输入到模型调用，每一层都是字符串

| 层 | 事实 | 证据 |
| --- | --- | --- |
| 输入 UI | 只有一个 `textarea`，没有 paste/drop/选择文件处理 | `src/renderer/components/agent/IrisAgentView.tsx:494-521` |
| 渲染端动作 | `sendIrisAgentMessage(sessionId, message: string)` | `src/renderer/lib/iris-agent-actions.ts:89-118` |
| IPC | `IRIS_AGENT_SEND` 载荷是 `{ sessionId, message: string }` | `src/main/ipc.ts:1003-1021` |
| 会话模型 | `AgentIntent.content`、`AgentMailboxEntry.content` 都是 `string` | `src/main/agent/session-model.ts:72`、`:88` |
| 历史投影 | `AgentHistorySnapshot.messages[].content: string`，且校验器强制字符串 | `src/shared/agent-protocol.ts:44-46`、`isHistorySnapshot` |
| Worker 协议 | `run.prompt: string`、`resume` 同样只带字符串 | `src/shared/agent-protocol.ts:91` |
| 模型调用 | `execute(input)` 直接 `messages.push({ role: 'user', content: input })` | `src/main/agent/pi-adapter.ts`（`createIrisPiSession.execute`） |
| 历史还原 | `toPiHistoryMessage()` 把每条历史拼成纯文本 user 消息 | `src/main/agent/pi-adapter.ts` |
| 工具结果 | 只有 `void` / `file(contentBase64)` / `terminal` / `task`，**没有 mimeType**；worker 把 `file` 按 UTF-8 解码 | `src/shared/agent-protocol.ts:130-160`、`src/main/agent-worker.ts:305-306` |
| 审计落盘 | provider payload 原样进 artifact（`messages`/`input` 在安全键白名单里） | `src/main/agent/context-artifact.ts`（`SAFE_PAYLOAD_KEYS`） |
| Token 预算 | 估算函数只按文本字符数算，图片没有计价项 | `src/main/agent/compaction.ts:42-83` |

两个直接后果：

1. **模型永远看不到图片**。即使把图片文件放进项目目录，Agent 也只能用 `read` 去读，
   而 `read` 的结果是 `file(contentBase64)` 被 worker 按 UTF-8 解码成字符串
   （`src/main/agent-worker.ts:305-306`、`src/main/agent/tool-host.ts` 的 `readFile`），
   拿到的是一串乱码而不是图像内容。
2. **模型也拿不到图片内容的元信息**。`AgentToolOperationResult` 的 `file` 分支没有
   `mimeType`，所以下游无法区分“这是文本”还是“这是 PNG”。

另外，Agent 回复卡片用 `ReactMarkdown + remarkGfm` 渲染，**没有接
`resolveMarkdownImage`**（`IrisAgentView.tsx:1042-1045`），所以回复里写本地图片路径
也显示不出来。这一条同样属于“Agent 图片功能”。

### 3. 图片生成：Iris 侧为零，pi-ai 侧已具备

Iris 侧：

- `IRIS_AGENT_PROVIDER_TEMPLATES` 只有 4 个 chat 模板，`IrisAgentProviderTemplate.api`
  只允许 `openai-responses` / `anthropic-messages`（`src/main/agent/provider-profiles.ts:6-35`、
  `src/shared/types.ts:676-682`）。
- 全仓库没有 `generateImages` / `ImagesModel` / `image-models` 的任何引用。
- provider profile 的持久化结构只有 `apiKey` + chat `models`，没有图片模型的维度
  （`provider-profiles.ts` 的 `StoredIrisAgentProviderProfile`）。

pi-ai 侧（`node_modules/@earendil-works/pi-ai/dist/`）：

- `types.d.ts:241-245` `ImageContent { type: 'image'; data; mimeType }`；
  `:290-293` `UserMessage.content: string | (TextContent | ImageContent)[]`；
  `:315` tool result 也允许图片内容块。
- `images.d.ts`、`images-models.d.ts`：`generateImages(model, context, options)`、
  `createImagesModels()`、`createImagesProvider()`，以及 `ImagesModel.output: ('text'|'image')[]`。
- `types.d.ts:17-22`：`KnownImagesApi = 'openrouter-images'`、`KnownImagesProvider = 'openrouter'`；
  `image-models.generated.js` 里全部是 openrouter 的图片模型（FLUX、Gemini Nano Banana 等）。
- `compat.d.ts` 已把 `./images.ts` 和内置图片 provider 一并导出，而 Iris 现在正是从
  `@earendil-works/pi-ai/compat` 导入——**不需要换入口就能用**。

### 4. 之前为什么没做（这是有记录的决策，不是遗漏）

`.iris/issue/2026-09-07-最近一次的agent执行记录检查.md` 明确写过：

> `read` 仍由 Iris 以 base64 在 worker/host 间传输，图片附件暂不纳入现有协议
> （当前协议只有文本文件结果），该差异已明确保留，不会静默伪装成图片支持。

> 原因是现有 Iris 协议只承载文本/终端结果……本轮先完成不会改变协议形状的核心契约对齐，
> 避免引入新的图片或日志架构。

而 `.iris/issue/2026-09-06-工具列表.md` 也把 `read_image` / `view_image` /
Image generation 列为“其他产品的按需能力”，Iris 当前 8 个工具里没有它们。

所以现状 = 有意的协议边界，不是 bug。要支持，就必须动协议形状和会话模型。

### 5. 要改多少：一个共同底座 + 三种能力

图片能力不是一件事，是三个可以分别决定的能力。它们共享同一个底座：
“协议里能承载图片内容块，并且图片字节有地方存”。

| 能力 | 现状 | 依赖 | 规模（含测试） |
| --- | --- | --- | --- |
| 底座：图片内容块 + 附件存储 | 无 | — | 约 350 行，协议 v15→v16 |
| A. 用户把图片发给 Agent（视觉输入） | 无 | 底座 | 约 900–1300 行 |
| B. Agent 读项目里的图片（`read` 识图 / `view_image`） | 无 | 底座 | 约 150–250 行（顺带增量） |
| C. Agent 生成图片（images provider + 工具） | 无 | 底座 + 新的 provider 概念 | 约 1000–1500 行 |

下面按“底座 → A → B → C”的顺序给方案。

### 6. 底座：图片内容块与附件

#### 6.1 数据模型

新增一个跨进程共享的附件描述，字节不放在消息里，只放标识：

```ts
// src/shared/types.ts + src/shared/agent-protocol.ts
export interface IrisAgentAttachmentRef {
  id: string;          // 会话内唯一
  name: string;        // 原始文件名，仅用于展示
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'image/avif';
  bytes: number;
  sha256: string;      // 内容寻址，天然去重
  width?: number;
  height?: number;
}
```

关键点：**消息体只带 `attachmentId`，不带 base64**。`AgentIntent.content` 保持原样，
新增 `attachments?: IrisAgentAttachmentRef[]`。这样 journal、投影、diff、compaction 的
文本语义全都不变，只有刻意读图的那一层才去加载字节。

#### 6.2 存储

沿用现有会话 artifact 目录，不做新仓库：

```
%APPDATA%/Iris/iris-agent-v3/projects/<key>/sessions/<hash>/artifacts/attachments/<sha256>.<ext>
```

对应 `src/main/agent/session-store.ts:520-528` 的 `sessionDir()` / `intentArtifactDir()`。
理由：agent 附件属于**应用数据**，不该写进用户仓库；想把它带进项目要走另一条显式路径
（能力 B/C 里再说）。引用计数用 sha256 去重，孤儿附件随会话删除一起清理。

#### 6.3 协议

```ts
// AgentHistorySnapshot.messages[] 的 content 变成联合类型
content: string | Array<{ type: 'text'; text: string } | { type: 'image'; attachmentId: string }>;

// run / resume 增加附件通道（prompt 仍是完整装配文本，图片是消息上的内容块）
| { type: 'run'; prompt: string; attachments?: IrisAgentAttachmentRef[]; ... }
```

`IRIS_AGENT_PROTOCOL_VERSION` 从 15 升到 16，`isHistorySnapshot` / `isAgentWorkerRequest`
校验器同步。因为 main 与 worker 是同一安装包内一起发布的（`AgentWorkerHost` 拉起
`agent-worker`），v16 不需要兼容 v15，只需保证旧会话能读能显示（见风险）。

#### 6.4 审计、token 与 compaction

- **审计**：`sanitizeProviderPayload` 的原样透传对图片是灾难——会把整张 base64 写进
  `provider-context/call-XXX.json` 和 `index.txt`。必须加规则：内容块 `type === 'image'`
  时替换为 `[image <sha256:8> <w>x<h> <bytes>B]`，字节永不进 artifact。
- **token 估算**：`estimateAgentTokens` 只算文本，图片要单独计价（例如按
  `ceil(w*h/750)` 或提供方固定档位），否则压缩触发点会系统性偏低。
- **compaction 材料**：`renderAgentCompactionSource` / `buildAgentContext` 遇到带图意图时
  用文本占位符（“用户附带 2 张图片，已省略”）表示，摘要请求不需要重发图片。

### 7. 能力 A：把图片发给 Agent（视觉输入）

这是“上传图片”这一半，也是最小可用的第一步。

#### 7.1 交互（渲染端）

- 输入框支持三种入口：**粘贴**（`paste` 事件的 `clipboardData.files`）、**拖入**
  （`dragover`/`drop`）、**选择文件**（需要新增一个 `dialog:pick-image` IPC，或复用
  `DIALOG_PICK_ASSET_PATH` 走主进程读文件）。
- 粘贴与拖入可以**完全在渲染端完成**：`File → arrayBuffer() → base64`，不需要文件系统权限；
  只有“选择文件”按钮需要主进程。
- 缩放与压缩：建议在渲染端用 `canvas`（或主进程 `electron.nativeImage.resize()`，零新依赖）
  把长边压到 1568px 以内再上传，否则一次截图就可能顶满上下文。
- 待发送区显示缩略图 + 文件名 + 尺寸，可单独删除；`submitDraft` 时一并提交。
- 已发送的意图在 `UserMessage` 里以缩略图网格展示（`IrisAgentView.tsx:1215`）。
- 模型能力门禁：`IrisAgentModelOption` 现在**没有暴露 `input`**
  （`src/shared/types.ts:633-649`，`pi-adapter.ts` 的 `toIrisModelOption` 丢掉了它）。
  需要补上 `capabilities.input`，当所选模型不支持图片时禁用附件按钮并给出说明。

#### 7.2 校验（主进程）

- MIME 白名单 + 签名嗅探：直接复用 `asset-manager.ts` 的 `detectImage()`，它已经按魔数识别
  PNG/JPEG/GIF/WebP/AVIF，并已明确拒绝 SVG。
- 单图大小上限（文档资产是 10 MiB；对 provider 建议更小，如 5 MiB）、每轮张数上限（建议 5）。
- 附件写入前校验 project scope，防止跨项目会话读到别的项目的会话目录。

#### 7.3 改动清单

| 文件 | 改动 | 估计 |
| --- | --- | --- |
| `src/shared/agent-protocol.ts` | 附件类型、content 联合类型、`run.attachments`、校验器、版本 16 | 80 |
| `src/shared/types.ts` | `IrisAgentUserView.attachments`、`IrisAgentModelOption.capabilities.input` | 25 |
| `src/main/agent/session-model.ts` | 意图/邮箱附件字段 + `normalizeAgentSessionAggregate` | 40 |
| `src/main/agent/session-store.ts` | 附件落盘/读取/清理（sha256 命名、原子写） | 120 |
| `src/main/agent/trace-context.ts` | user 消息投影为 content parts | 40 |
| `src/main/agent/session-manager.ts` | `send()` 增加附件参数、校验、mailbox 透传、prompt facts | 150 |
| `src/main/agent/pi-adapter.ts` | `toPiHistoryMessage` 出 image 块、`execute` 接受附件、`toIrisModelOption` 带 capabilities | 70 |
| `src/main/agent-worker.ts` | `run` 消息组装为 parts | 40 |
| `src/main/agent/compaction.ts` | 图片 token 估算 + 摘要材料占位 | 40 |
| `src/main/agent/context-artifact.ts` | 图片 base64 占位化 | 30 |
| `src/main/ipc.ts` + `src/preload/index.ts` + `global.d.ts` | send 载荷带附件；可选 `dialog:pick-image` / 附件读回通道 | 80 |
| `src/renderer/lib/iris-agent-actions.ts` | `sendIrisAgentMessage` 支持附件 | 40 |
| `src/renderer/components/agent/IrisAgentView.tsx` | 粘贴/拖入/选择、待发送缩略图、用户消息附图 | 200 |
| 测试 | 协议校验、store 附件往返、pi-adapter 映射、composer 行为 | 250 |

合计约 **1200 行**，其中测试约 250 行。改动文件 13 个，无新依赖。

### 8. 能力 B：Agent 读项目里的图片

能力 A 做好后，这一项就是把同一套内容块用在工具结果上。

- 方案一（最小）：让现有 `read` 自动识图——`tool-host` 的 `readFile` 分支用 `detectImage()`
  判断，是图片就返回 `{ kind: 'image', mimeType, contentBase64, width, height }`，
  worker 把它变成 `toolResult` 的 image 内容块；模型不必多学一个工具。
- 方案二（对齐其他产品）：新增 `view_image` 工具，语义更窄、更可发现，但会改
  `AgentToolName` 联合、prompt 工具清单、`IRIS_PI_TOOL_NAMES` 和 schema token 预算。

建议方案一，理由：Iris 的 `read` 本来就承诺“读文件”，把图片当成文件的一种更自洽；
而 prompt 工具清单保持不变，可以避免动 `IRIS_AGENT_PROMPT_METADATA.adaptedBasePromptSha256`
这个被测试硬编码的指纹（`src/main/agent/prompt.test.ts:19`）。

增量改动：`agent-protocol.ts`（`file` 结果加 `mimeType`/尺寸，或新增 `image` 分支）、
`tool-host.ts`、`agent-worker.ts`（base64 → image 块）、`pi-adapter.ts` 的 read 工具返回、
`session-model.ts` / `trace-context.ts`（工具结果也要能是图片，history 里存 attachmentId）。
约 150–250 行。

附带收益：Agent 从此能自己看截图 / 设计稿，这对“产品截图与演示项目”这类工作直接有用。

### 9. 能力 C：Agent 生成图片

这一半是完全独立的链路，也是最贵的。

#### 9.1 缺什么

1. **Provider 概念**：Iris 现在只有 chat profile。需要新增 images profile
   （`templateId: 'openrouter-images'`、baseUrl、apiKey、可用图片模型列表），
   并在 `provider-profiles.ts` 的持久化结构、`profilesForRenderer`、设置页里各加一路。
   注意 pi 内置只有 `openrouter-images` 这一种图片 API，所以 v1 的现实选择是
   “只支持 OpenRouter（可自定义 baseUrl）”。
2. **工具**：新增 `image_generate`（prompt / 尺寸 / 张数 / 可选参考图）。它在 **worker**
   里调用 provider（不是 host），因此需要新的一条“工具在 worker 内自带实现”的路径——
   现有 8 个工具全部是“worker 求值 → 转发给 main 的 tool-host 执行”，这是新形状。
3. **结果形态**：生成的图要落盘（`artifact` 或项目路径）、要在聊天里显示、要能进入
   history。于是 `AgentToolActivity` / `AgentTurn.toolResults.content: string`
   必须支持内容块，卡片类型 `IrisAgentCardView` 要加图片卡片。
4. **与文档资产的衔接**：真正好用的形态是“生成 → 存进 `<doc>.assets/` → 自动给出
   Markdown 链接”。这样生成图就复用现有资产协议，而模型不必自己拼 base64 写入。
   代价是图片工具需要知道“当前锚定文档”（session anchor 已有，能拿到）。

#### 9.2 改动清单

| 文件 | 改动 | 估计 |
| --- | --- | --- |
| `src/main/agent/provider-profiles.ts` + `shared/types.ts` | images profile 类型/持久化/投影 | 180 |
| `src/main/agent/pi-adapter.ts` | `createImagesModels` 接入、images 工具定义与执行 | 200 |
| `src/shared/agent-protocol.ts` | 新工具名、`image_generate` 输入、图片结果分支、版本 | 80 |
| `src/main/agent-worker.ts` | worker 内工具执行形状、结果回传 | 120 |
| `src/main/agent/tool-host.ts` + `session-store.ts` | 生成图落盘与引用 | 120 |
| `src/main/agent/session-model.ts` + `trace-context.ts` | 图片工具结果进入 history | 80 |
| `src/main/agent/prompt.ts` + 测试 | 工具清单与 `adaptedBasePromptSha256` 更新 | 40 |
| `src/renderer/components/settings/SettingsView.tsx` | 图片 provider/模型设置 | 200 |
| `src/renderer/components/agent/IrisAgentView.tsx` | 图片卡片、点击查看、插入文档按钮 | 180 |
| `src/main/ipc.ts` + preload | 设置与读取通道 | 80 |
| 测试 | provider、工具、卡片、协议 | 250 |

合计约 **1300–1500 行**。这条路会真正引入“图片是一种工具结果”的架构，
而不是像 A/B 那样只在消息通道上传字节。

### 10. 分期建议（若决定要做）

1. **P0 底座**：协议 v16 + 附件存储 + 内容块投影（无 UI，纯内部）。
2. **P1 视觉输入**：粘贴/拖入/选择 + 缩略图 + 能力门禁。做完这一步，
   “上传图片”这个问题就解决了。
3. **P2 读图**：`read` 识图，Agent 能自己看项目里的截图。
4. **P3 生成**：images provider + `image_generate` + 设置页 + 资产衔接。

P0 与 P1 不可分割（分开会留下半个协议）。P2 依赖 P0。P3 依赖 P0，
但与 P1/P2 可以互换顺序。

### 11. 风险与代价

- **协议破坏性升级**：v15→v16 要保证旧会话仍能读取与展示（附件字段全可选即可），
  否则就是一次会话数据清理。这是本方案最大的回归面。
- **上下文成本**：一张 1568px 截图在主流模型上是 1000+ token 量级。必须在 UI 上
  明确显示附件与开销，并让 token 估算覆盖图片，否则水位指示器会失真。
- **审计体积**：不加占位规则的话，用户截图会以 base64 全量进入
  `provider-context` artifact 和 `index.txt`，体积与隐私都不可接受。
- **隐私**：上传的图片会离开本机送到用户配置的 provider；Iris 需要在发送前明确提示，
  并且默认只把附件存放在 `%APPDATA%` 的会话目录，不自动落进项目仓库。
- **模型能力差异**：不支持视觉的模型必须显式禁用，而不是静默丢图（这正是 2026-09-07
  那条决策的立场：不静默伪装成图片支持）。
- **生成环节的新依赖面**：pi 的图片 API 目前只有 OpenRouter 一路，且出图质量/价格
  完全由第三方决定；Iris 需要为自己的“图片 provider profile”定义清楚它只是 chat
  profile 的兄弟概念，而不是新的账号体系。

### 12. 需要你决定的问题

- [x] 是否要做「Agent 自己读项目里的图片」（能力 B / `read` 识图）——已实现，见下节
- [x] 是否要做「用户把图片发给 Agent」（能力 A / 视觉输入）——已实现，见下节
- [x] 附件默认只存在会话私有目录（`%APPDATA%`，不进仓库）——已按此实现
- [x] 确认上限策略：单图 ≤ 5 MiB、长边缩到 ≤ 1568px、每轮 ≤ 5 张——已按此实现
- [x] 确认协议 v15→v16 的迁移立场：旧会话保持可读——已按此实现
- [ ] 是否要做「Agent 生成图片」（能力 C）：本轮**明确不做**；若以后要做，是否接受 v1 只支持 OpenRouter Images（可自定义 baseUrl）
- [ ] 确认是否接受为图片生成新增「images provider profile」这一独立设置项
- [ ] 是否允许把会话附件一键“导出到项目资产”（当前只存在会话私有目录）

---

## 实现报告：打通读取线（2026-09-10）

指令是“把读取线打通”。所以本轮做的是**能力 B**：Agent 能自己看项目里的图片；
顺带把底座里图片内容块、附件存储、审计/token/压缩三块该有的地方一起立住。
能力 A（用户上传）和能力 C（生成）**未动**，见“未做与后续”。

### 13.1 实际行为

模型对图片文件调用 `read` 时，拿到的是一条 tool result，内含两个内容块：

```text
[ { type: 'text',  text: 'docs/images/overview.png: image image/png 1280x720 (912.4 KiB).' },
  { type: 'image', data: '<base64>', mimeType: 'image/png' } ]
```

文字块保留文件名、类型、像素尺寸和体积：模型需要能引用它刚看到的东西；
裸图块会让它无法说明“这不是我期待的那张图”。

边界保持“不静默伪装成图片支持”的立场：

| 情况 | 行为 |
| --- | --- |
| 魔数识别为 PNG/JPEG/GIF/WebP/AVIF，且 ≤ 5 MiB | 返回真图块 |
| SVG、非图片、超过 5 MiB | 退回原有文本路径，模型拿到的是真实字节 |
| `edit` 的 read-before-write | **永不**返回图片（它需要文本语义），否则会拒绕 |
| 附件文件丢失后重放 | 回 NACK，而不是编造一张图 |
| 图片读发生在 `offset`/`limit` 下 | 忽略分页参数，整图返回（分页是文本概念） |

### 13.2 关键设计：字节不进 journal

这是实现中最重要的一条决定，也与本文档前面的方案不同：

- **写入时**：图片字节落到
  `<userData>/iris-agent-v3/projects/<key>/sessions/<hash>/artifacts/attachments/<sha256>.<ext>`，
  以内容哈希命名（天然去重，重复读同一张截图零成本）。journal 里只写
  `AgentStoredToolResult`（`attachmentId` + MIME + 尺寸），**永不写 base64**；
  Turn 的 toolResult 同样只存引用。
- **投影时**：`session-store.history()` 现在会按引用把字节读回来拼成内容块。
  所以 journal 是追加日志，大小不会因为一张截图而无限增长；同时重放与
  首次发送完全一致（重复投递同一 tool-request 会得到同一张图，已有测试）。
- **代价**：`history()` 从同步变成 async（11 处调用点跟上）。这是必须的：
  字节是文件，不可能在不碰磁盘的前提下就位。

相比之下，若按原方案把 `AgentToolOperationResult` 整体存进 operation，就不是
“字节进 journal”而是“每次 commit 都重写一遍字节”，两者都不可接受。

### 13.3 改动清单（已落地）

新增：

| 文件 | 作用 |
| --- | --- |
| `src/main/image-signature.ts` | 魔数识别 + 固有尺寸解析（PNG/JPEG/GIF/WebP/AVIF） |
| `src/main/agent/tool-result-content.ts` | 工具结果 → provider 内容块的**唯一**翻译点 |

`image-signature.ts` 同时被 `asset-manager.ts` 复用：原来那份手写的魔数表已删，
文档资产与 Agent 读取自此共用一张签名表，不会再分叉。

修改：

| 文件 | 改动 |
| --- | --- |
| `src/shared/agent-protocol.ts` | 协议 v15→**v16**；`AgentContentPart` / `AgentMessageContent` / `AgentHistoryMessage`；工具结果新增 `kind: 'image'`；校验器（`isMessageContent` / `isAttachment` / `isImageMimeType`）；摘要把图片字节换成内容哈希 |
| `src/shared/types.ts` | `IrisAgentAttachment`、`IRIS_AGENT_IMAGE_MIME_TYPES`、`IrisAgentAttachmentData`、检索项的 `image` |
| `src/shared/protocol.ts` | `IRIS_AGENT_ATTACHMENT_READ`（只按 id 取图，不接受路径/MIME） |
| `src/main/agent/tool-host.ts` | `read` 识别图片；`AGENT_READ_IMAGE_MAX_BYTES = 5 MiB` |
| `src/main/agent/pi-adapter.ts` | `IrisReadFileResult` 与 `readMediaFile`；read 工具返回文本 + 图块；`toPiContent` 映射历史内容块 |
| `src/main/agent-worker.ts` | `readMediaFile`/`readFile` 两个操作；tool result 走共享翻译 |
| `src/main/agent/session-model.ts` | `AgentTurn.toolResults[].attachments`、`AgentToolActivity.imageAttachment`、`AgentStoredToolResult` |
| `src/main/agent/session-store.ts` | 附件存取（内容寻址 + 原子写 + 目录校验）；`history()` 水合；分支复制附件 |
| `src/main/agent/trace-context.ts` | 工具结果投影携带附件引用 |
| `src/main/agent/session-manager.ts` | `persistToolImage`、`rehydrateToolResult`、`readAttachmentData`、Turn 记录引用 |
| `src/main/agent/compaction.ts` | 图片按像素计价 `ceil(w*h/750)+85`；未知尺寸保守 1600；按 attachment id 去重；摘要材料标注“图片已省略” |
| `src/main/agent/context-artifact.ts` | 图片块（Pi / Anthropic / OpenAI `image_url` data URL 三种形状）占位化，只报字节数 |
| `src/main/agent/prompt.ts` | 适配版 v5：说明 read 会返回像素及其上下文代价，并给出新指纹 |
| `src/main/ipc.ts` | `IRIS_AGENT_ATTACHMENT_READ` handler |
| `src/renderer/lib/iris-agent-actions.ts` | `readIrisAgentAttachment` |
| `src/renderer/components/agent/IrisAgentView.tsx` | 检索卡片增加受限缩略图（最大高度 40，失败时明说不可读） |

规模：`src` 下 25 个文件改动（+1606 / −125），另新增 5 个文件（含测试）。
与预估的“能力 B 增量 150–250 行”不符——因为底座（内容块 + 附件存储 +
审计 + token + 压缩）实质上一起做了，这与前面“P0 与 B 不可分割”的判断一致。

### 13.4 被刻意守住的不变量

- **审计不含像素**：用户截图不会再以 base64 写进 `provider-context/call-XXX.json`
  与 `index.txt`（否则 artifact 体积与隐私都不可接受）。
- **水位指示器不失真**：一张 1568×882 截图计为 ~1930 token，而不是“一行短文本”。
- **摘要不重发图片**：`renderAgentCompactionSource` 用文本占位，摘要请求仍是纯文本。
- **不静默降级**：模型能力不支持、图片过大、字节丢失，都表现为明确事实。
- **旧会话可读**：`IRIS_AGENT_SESSION_STORE_VERSION` 未动（仍是 3），附件字段全部可选，
  所以 v16 不需要一次会话数据清理。
- **参数不信任**：附件路径由 sha256 + MIME 推出；id 不是 64 位十六进制就拒绕。
  渲染端只能传 id，无法指定路径或伪造 MIME。

### 13.5 验证

- `npm run typecheck`（含 `check:async`）通过。
- `npx vitest run`：**94 个文件、596 项测试全绿**（本轮新增 29 项）。
- 新增/扩展的针对性覆盖：
  - `image-signature.test.ts`：五种格式识别与尺寸解析；SVG 拒绕；截断/超大/零尺寸头
  - `tool-result-content.test.ts`：文字与像素共存、尺寸单位、文本/终端/任务分支
  - `context-artifact.test.ts`：三种图片形状均被占位，且报出真实字节数
  - `tool-host.test.ts`：图片读取、分页参数被忽略、SVG/超大退回文本、edit 不拿图
  - `session-store.test.ts`：内容寻址去重、字节不落 journal、字节丢失不编造图、伪造 id 拒绕
  - `session-manager.test.ts`：端到端读图 → 快照 → 渲染端取图 → 后续请求重放同一张图 → 重放
  - `pi-adapter.test.ts` / `agent-protocol.test.ts`：图块与历史重放、摘要对编码不敏感
  - `compaction.test.ts`：按像素计价、摘要材料省略图片
- 未执行：`npm run agent:worker-check`。它是包装检查，在**未重新构建**的树上会报
  “source protocol v16, artifact protocol v15”（`out/` 是旧产物）。按你的约定
  未为测试而跑构建，因此这一项留给你。

### 13.6 未做与后续（读取线当时的状态）

- ~~**能力 A（用户上传图片）未做**~~：已在本轮（14）实现。
- **能力 C（生成图片）未做**：`image_generate` / images provider profile / 设置页均未动。
- **Agent 回复里的本地图片仍不渲染**：`AgentReplyCard` 仍只有 `ReactMarkdown`，
  未接 `resolveMarkdownImage`。本轮聚焦读取线，未扩展为通用媒体渲染。
- **附件清理**：会话删除会随目录一起走；但不做跨会话引用计数，也没有孤儿回收器。
- **无大小/张数配额**：单图 5 MiB 上限已实现，但没有每会话总量上限。

### 13.7 需要你验收

- [ ] 在一个真实项目里让 Agent `read` 一张截图（例如 `docs/images/readme-overview.png`），确认它真的“看见了”并回答正确
- [ ] 确认左侧“信息检索”卡片里出现缩略图，且失败时说的是不可读而不是空白
- [ ] 确认一次图片读取后，`provider-context/call-XXX.json` 里没有 base64，只有占位说明
- [ ] 确认上下文水位在含图请求后明显上升（而不是按文本计）
- [ ] 确认旧会话（v15 时代建立的）能正常打开、续话
- [ ] 重新构建后补跑 `npm run agent:worker-check`

---

## 实现报告：能力 A 用户上传图片（2026-09-10）

本轮指令是“能力 C 暂时不实现，能力 A 现在实现”。所以下面只写能力 A。

### 14.1 实际行为

输入框旁边多了一个图片按钮，同时支持三条入口：**粘贴**、**拖入**、**点击选择**。
待发送区以缩略图形式显示附件，可单个移除；发送后附件显示在“你的指令”卡片里。

### 14.2 信任边界：渲染端说什么都不算

这是本轮最重要的设计决定，也决定了 IPC 载荷的形状。

渲染端只向主进程发两个字段：

```ts
{ name: string; dataBase64: string }   // IrisAgentAttachmentUpload
```

**没有 mimeType，没有宽高。** 主进程收到后重新做一遍：

1. 先查编码后长度（不解码，避免为恶意载荷分配内存）；
2. base64 解码，非空；
3. 魔数嗅探真实格式（`detectImageBytes`）；
4. 从字节解析真实像素尺寸（`readImageSize`）；
5. 总量/张数校验后写入附件存储。

所以一个改名成 `.png` 的 PDF、或声称自己是 PNG 的 SVG，都会在写入前被拒绕。
存储路径由 sha256 + MIME 推出，与文件名无关。

### 14.3 上限（在主进程强制，不在 composer）

| 限制 | 值 | 理由 |
| --- | --- | --- |
| 单图字节 | 5 MiB | 与读取线同一个常量；一次请求可能要重发它 |
| 每轮张数 | 5 | 超过后提示用户分批 |
| 单次总量 | 12 MiB | 防止 5×5 MiB 一次性进入一个请求 |
| 长边 | 1568 px | composer 缩放目标，压低一次截图的后续代价 |

### 14.4 缩放策略

只在超过长边时重编码，且输出格式跟随源：**PNG 保持 PNG**（截图文字边缘不糊），
其余转 JPEG（照片保持无损会得到比原图更大的文件）。重编码后如果反而变大，
就放弃它用原图——不为了“处理过”而把图弄得更差。

`image-signature.ts` 从 `src/main/` 移到 `src/shared/` 并用 `DataView` 重写（去掉了
`Buffer` 依赖），因为渲染端也需要同一个魔数表：要挑 PNG/JPEG 输出、要在选文件时
立即拒绝 SVG。现在 **asset-manager / 读取线 / composer 共用一张签名表**。

### 14.5 模型能力门禁

`IrisAgentModelOption` 新增 `capabilities.input`，由 Pi 目录的 `input: ('text'|'image')[]`
透传。**未声明就是不支持**（不是“假定支持”）：不支持时按钮禁用并给出 tooltip 说明；
模型切到不支持图片时，已附加的图会被移除并说明原因，而不是静默地发给一个会忽略它的模型。

### 14.6 改动清单

新增：

| 文件 | 作用 |
| --- | --- |
| `src/shared/image-signature.ts` | 魔数识别 + 尺寸解析（从 `src/main/` 移入，改用 `DataView`） |
| `src/renderer/lib/agent-image-attachments.ts` | 文件 → 校验 → 缩放 → 待发送附件 + object URL 生命周期 |

修改：

| 文件 | 改动 |
| --- | --- |
| `src/shared/agent-protocol.ts` | `AgentPromptImage`；`run.attachments`；`AGENT_IMAGE_MAX_BYTES` / `AGENT_ATTACHMENT_MAX_COUNT` / `AGENT_ATTACHMENT_MAX_TOTAL_BYTES` / `AGENT_ATTACHMENT_MAX_EDGE`；校验器 |
| `src/shared/types.ts` | `IrisAgentAttachmentUpload`、`IrisAgentModelInput`、`capabilities.input`、`IrisAgentUserView.attachments` |
| `src/main/agent/session-model.ts` | Intent / MailboxEntry 的 `attachments`；投影回填 |
| `src/main/agent/trace-context.ts` | user 消息携带附件引用 |
| `src/main/agent/session-manager.ts` | `persistUserAttachments`（全部校验）、`promptImagesFor`、`sendStored`（邮箱重放不重传）、`applyContextMeasurement` 计入图片、`readAttachmentData` 覆盖 intent/mailbox |
| `src/main/agent/pi-adapter.ts` | `renderPromptContent`（提示词 + 图块同一 user 消息）；`toIrisModelOption` 输出 capabilities；`prompt(input, images)` |
| `src/main/agent-worker.ts` | `run.attachments` 传给 `session.prompt` |
| `src/main/agent/compaction.ts` | `estimateAgentAttachmentTokens` |
| `src/main/ipc.ts` | `IRIS_AGENT_SEND` 的 attachments 边界校验（这一层是信任边界） |
| `src/renderer/lib/iris-agent-actions.ts` | `sendIrisAgentMessage(..., attachments)` |
| `src/renderer/components/agent/IrisAgentView.tsx` | 三种入口、待发送缩略图、已发送缩略图、能力门禁、拖入高亮 |
| `scripts/check-async-boundaries.mjs` | 登记 `addImageFiles`（内部已捕获并展示内联错误） |

规模：本轮 `src` + `scripts` 改动 27 个文件（+2545 / −152，含上一轮），另新增 4 个文件。
无新依赖。

### 14.7 被刻意守住的不变量

- **图片随请求同一条 user 消息发送**：请求是一轮，图就属于这一轮，而不是另起一条让
  provider 去关联的消息（`renderPromptContent`）。纯文本请求保持字符串形式，旧路径不变。
- **字节仍然不进 journal**：Intent 只存附件引用；与读取线共用同一套内容寻址存储。
  测试断言 `JSON.stringify(persisted)` 不含 base64。
- **邮箱重放不重传**：排队消息存的是已落盘的引用，dispatch 走 `sendStored`，
  不会退回渲染端再要一次（否则用户已清空的 composer 就找不回来了）。
- **Fork 拿到自己的副本**：Branch 复制整个 attachments 目录，否则分支会引用只有源会话有的文件。
- **水位计入图片**：当前 Intent 还没 Turn、不在 history 里，所以 `applyContextMeasurement`
  显式接收附件并按像素计价，否则含图请求的水位会偏低。
- **不静默丢弃**：图片丢掉（存储失败、文件丢失、模型不支持）都表现为明确错误或说明。

### 14.8 验证

- `npm run typecheck`（含 `check:async`）通过。
- `npx vitest run`：**95 个文件、610 项测试全绿**（连跑两次稳定）。
- 本轮新增/扩展：
  - `src/renderer/lib/agent-image-attachments.test.ts`（新）：格式由字节决定而非文件名、
    拒 SVG/非图、超限拒绕、张数门禁、drop/paste 只取图片文件
  - `session-manager.test.ts`：上传→校验→存储→请求携带→投影→渲染端取图→后续请求重放同一张；
    Intent 与 journal 不含 base64；SVG/空数据/超 5 MiB/超 5 张 均被拒且不创建 Intent；
    排队消息带图重放；input fork 拿到自己的附件副本（retry 重发仍然带图）
  - `agent-protocol.test.ts`：`run.attachments` 校验（含缺字段、错类型、错 part 类型）
  - `pi-adapter.test.ts`：`renderPromptContent` 同一条消息；capabilities 三种情形
  - `image-signature.test.ts`：移到 `src/shared/` 后全绿（改用 `DataView` 实现）
  - `iris-agent-store.test.ts`：静态渲染补上 app 级 `TooltipProvider`（新按钮用了 Tooltip）
- 未执行：`npm run agent:worker-check`（未重新构建，同 13.5）。

### 14.9 需要你验收

- [ ] 粘贴一张截图到输入框，确认出现缩略图且可单独移除
- [ ] 拖入图片、点击图片按钮选择文件，确认两条入口都可用
- [ ] 发送后确认“你的指令”卡片里显示图片缩略图，重开软件后仍在
- [ ] 选一个不支持视觉的模型，确认图片按钮禁用并说明原因；带图时切到该模型确认图片被移除且有提示
- [ ] 拖入一个非图片文件（如 `.txt`），确认被拒且提示原因
- [ ] 粘贴一张 4K 截图，确认被缩到长边 ≤ 1568px 后发送，且水位明显上升
- [ ] 确认 `provider-context/call-XXX.json` 里没有 base64（与读取线同一条占位规则）
- [ ] 运行中再发一条带图消息，确认它排队并能带图重放
- [ ] 重新构建后补跑 `npm run agent:worker-check`

### 14.10 未做

- **能力 C（生成图片）不做**：`image_generate`、images provider profile、设置页均未动。
- **Agent 回复里的本地图片仍不渲染**：`AgentReplyCard` 仍只有 `ReactMarkdown`。
- **图片不能单独发送**：必须有文字（或命中文档锚点的默认指令）。故意不发明
  “看图”之类的固定提示词。
- **无每会话总量配额**：只有单次请求的字节与张数上限。
- **不做图片编辑**：不能裁剪、标注或旋转，只能靠外部工具处理好再传。

---

## 代码审核：图片读取与上传实现（2026-09-10）

### 审核结论

这份实现不是“模型乱写后碰巧过测试”：整体架构方向正确，尤其是附件按内容哈希落盘、
journal 只存引用、主进程从字节重新识别格式、provider artifact 去除 base64、旧会话字段保持
可选，这些关键边界都有实现和测试支撑。

但当前版本仍然**不建议合并**。审核发现 1 个会静默改变用户请求的阻断问题，以及数个会造成
输入丢失、磁盘残留或约束失效的问题。现有 615 项测试全部通过，但没有覆盖这些组合分支，
所以“全绿”不能证明图片链路已经闭环。

### P0：上下文溢出自动重试会静默丢掉本轮图片

首次带图请求若收到 provider 的 context overflow，`retryAfterContextOverflow()` 会重新组装
文字并创建新的 Worker，但重试的 `run` 消息没有携带 `currentIntent.attachments`：

- `src/main/agent/session-manager.ts:1651-1671`：`applyContextMeasurement()` 未传附件，
  `host.post({ type: 'run' })` 也未设置 `attachments`。
- 对比正常的首次发送 `src/main/agent/session-manager.ts:704-719` 和首次 Turn 前手动重试
  `:1041-1060`，这两条路径都会调用 `promptImagesFor()` 并传图片。
- 现有 overflow 测试 `src/main/agent/session-manager.test.ts:2464-2498` 只发送纯文本，因而没有
  发现这个缺口。

结果是：用户明确发了图片，第一次调用溢出后，自动重试只把文字发给模型，UI 又不会告诉用户
图片已被移除。这与实现报告里“不静默丢弃”的不变量直接冲突。

同一处还有前置判断遗漏：`compactForThreshold()` 在 `src/main/agent/session-manager.ts:873-876`
只估算 prompt + history，没有计入本轮尚未进入 history 的附件；图片可能本应触发发送前压缩，
却要等 provider 真正报 overflow 才补救。

- [ ] 修复 overflow 自动重试：重新读取并发送当前 Intent 的附件，同时把附件计入重试后的水位测量
- [ ] 修复发送前阈值判断：让 `compactForThreshold()` 接收并计入本轮附件 token
- [ ] 新增“带图请求 -> context overflow -> 压缩 -> 重试仍带同一图片”的回归测试

### P1：附件保存不是原子的，失败请求会留下不可达文件

`persistUserAttachments()` 在 `src/main/agent/session-manager.ts:561-589` 中逐张校验、逐张调用
`saveAttachment()`。如果前两张有效、第三张格式错误或使总量超过 12 MiB，前两张已经写入
`artifacts/attachments/`，但不会创建 Intent，也没有任何引用或回滚。

即使全部图片校验通过，附件也在 `resolveUserMessage()`、模型可用性检查、prompt 准备等动作之前
落盘；这些后续动作失败同样会产生孤儿。项目当前没有会话内孤儿回收器，而 branch 会复制整个
attachments 目录，所以残留还可能被放大。

- [ ] 先完成整批解码、格式、单图大小、总大小和尺寸校验，再统一落盘；或为失败发送实现精确回滚
- [ ] 新增“后续附件无效/总量超限/发送后续步骤失败时 attachments 目录无新增文件”的测试

### P1：发送失败时 composer 会丢掉文字和已选图片

`src/renderer/components/agent/IrisAgentView.tsx:285-291` 在等待 IPC 结果之前就清空 draft、撤销
所有 object URL 并清空附件。`sendIrisAgentMessage()` 在
`src/renderer/lib/iris-agent-actions.ts:92-128` 又把 `ActionOutcome` 吸收成 `Promise<void>`，组件
无法判断失败并恢复内容。

这对图片存在一个稳定可复现的路径：renderer 只检查每张 ≤ 5 MiB 和最多 5 张，没有检查整批
≤ 12 MiB；选择三张各约 4.5 MiB 的图片时 composer 会接受，主进程在
`src/main/agent/session-manager.ts:579-581` 拒绝，随后用户的文字和三张图片全部消失，只剩错误通知。

- [ ] 让发送动作把成功/失败结果返回给 composer，只在成功入队或成功启动后清空输入
- [ ] renderer 同步检查 12 MiB 总量，主进程仍保留同一校验作为信任边界
- [ ] 新增“主进程拒绝附件后 draft 与缩略图仍保留”的组件/动作测试

### P1：长边 ≤ 1568px 只是尽力而为，不是实际约束

`downscaleIfNeeded()` 在 `src/renderer/lib/agent-image-attachments.ts:127-149` 即使发现长边超过
1568，也只在重编码结果比原文件更小时采用新图。对压缩率很高的低质量 4K JPEG，按 0.92 质量
重编码后的 1568px 文件可能更大，于是函数退回原始 4K 图片。解码或 `canvas.toBlob()` 失败时
也会退回原图。

主进程在 `src/main/agent/session-manager.ts:583-589` 只读取尺寸并存储，没有拒绝或缩放超长边图片。
另外 renderer 硬编码了自己的 `MAX_EDGE = 1568`，没有使用已经导出的
`AGENT_ATTACHMENT_MAX_EDGE`，后续很容易漂移。

- [ ] 明确 1568px 是强约束还是优化目标；若是强约束，超长边时必须采用缩放结果或明确拒绝，不能退回原图
- [ ] renderer 使用共享常量，并在主进程对尺寸约束做最终校验
- [ ] 新增“缩放后字节反而变大”和“图片解码失败但头部尺寸超限”的测试

### P1：模型视觉能力只在 renderer 门禁，主进程没有执行契约

renderer 在 `src/renderer/components/agent/IrisAgentView.tsx:181-195` 根据 catalog 禁用图片按钮，
但主进程的 `assertUsableModel()`（`src/main/agent/session-manager.ts:2468-2470`）只检查 Session 是否
有 model，不检查所选模型是否声明 `input: image`。因此过期 UI 状态、直接 IPC 调用或 catalog
变化都能把图片送入文本模型，最终行为取决于 provider 是报错还是忽略图片。

- [ ] 主进程在接收非空附件时重新核对所选模型 capability，不支持时在创建 Intent 前明确拒绝
- [ ] 新增“文本模型通过 IPC 发送图片被主进程拒绝且不创建 Intent/附件”的测试

### P2：粘贴同时含文字和图片时，文字会被吃掉

`src/renderer/components/agent/IrisAgentView.tsx:683-689` 的注释写着保留 clipboard text，但只要
检测到图片就调用 `event.preventDefault()`，之后没有手工插入 `text/plain`。从网页、Office 或某些
截图工具粘贴同时带文字和图片的 clipboard payload 时，最终只会加入图片。

- [ ] 要么不要阻止默认文字粘贴，要么在拦截后显式把 `text/plain` 插入当前 selection
- [ ] 新增“clipboard 同时含 text 与 image 时两者都保留”的测试

### P2：历史缩略图全部立即加载，长会话存在明显内存放大

`RetrievalImage` 和 `SentAttachmentImage` 挂载后立即通过 IPC 读取完整 data URL，没有可视区懒加载、
共享缓存或 object URL 释放机制。单张 5 MiB 图片会在 base64 字符串中额外膨胀约三分之一；长会话
重新打开时，所有已渲染图片会同时进入 renderer 内存，同一内容在不同卡片中还会重复读取。

- [ ] 为历史图片增加可视区懒加载或展开后加载，并避免同一 attachment id 重复保存完整 data URL
- [ ] 增加多轮大图会话的内存/加载行为测试或至少设置每会话附件总量策略

### 本次独立验证

- `npm run typecheck`：通过（含 `check:async`）。
- 图片相关针对性测试：10 个文件、144 项通过。
- 全量 `npx vitest run`：95 个文件、615 项通过。
- `git diff --check`：没有空白错误；只有工作树既有的 LF/CRLF 提示。
- 按项目约定未运行 `npm run build`、`npm run dist`，也未启动开发服务器做截图替代手测。

### 建议处理顺序

先修 P0 的溢出重试丢图，再修附件原子性和发送失败回滚；这三项完成前不建议进入人工验收。
长边约束与主进程 capability 校验应在合并前补齐。粘贴混合内容和历史图片内存问题可以排在后面，
但应保留为明确任务，不能让它们从 todo 面板消失。
