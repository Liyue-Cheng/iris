---
title: 实现基于 Exa MCP 的 web_search 工具
status: Todo
---

## 目标

为 Iris 增加 `web_search` 工具，通过外置 Exa MCP 提供互联网搜索能力。Iris 不内置搜索引擎、Docker、Camofox、Python 或浏览器运行时，只负责本地 MCP 客户端适配和工具结果转换。

## 产品边界

这是“本地工具调用 + 云端搜索 provider”方案：

- 用户需要配置 Exa MCP 的 API key 或服务方要求的认证信息。
- 查询内容会发送到 Exa 服务。
- 搜索依赖网络、服务可用性、配额和服务条款。
- 未配置 provider 时不注册 `web_search`，或返回明确的配置提示。

第一版只接入 Exa；Parallel MCP 作为后续可选 provider，不在第一版同时深度绑定。

## 外部端点

```text
https://mcp.exa.ai/mcp
```

本地适配层通过 Streamable HTTP MCP 完成初始化、能力协商和 `tools/call`，调用 Exa 的搜索工具。

## Iris 接入位置

- 新增独立 MCP client 模块，避免把 Exa 字段扩散到 Pi 工具定义。
- 在 `IrisToolHostOperations` 增加 web search 能力。
- 在 `createIrisPiToolDefinitions()` 注册 Iris 自己的 `web_search` schema。
- worker/tool host 负责取消、超时和调用结果回传。
- provider 配置独立于模型 provider，支持启用开关、endpoint、API key 和超时。

## Iris 工具参数

```text
query: string
maxResults?: number
livecrawl?: fallback | preferred
type?: auto | fast | deep
contextMaxCharacters?: number
```

Iris 对模型暴露稳定参数，内部再映射为 Exa MCP 的 `web_search_exa` 参数；模型不应依赖 Exa 私有工具名或字段。

## 运行时要求

- MCP 初始化失败、鉴权失败、超时、限流和错误响应都转换成模型可理解的结构化工具错误。
- 限制结果数量、上下文字符数、并发数和重试次数，避免成本失控。
- API key 只保存在安全配置中，不写入 `.iris/`、prompt、日志或 renderer。
- 网页和搜索结果视为不可信外部输入，不能改变系统策略或触发未授权工具调用。
- provider endpoint 和响应结构进行严格校验，便于未来替换 Parallel 或其他 provider。

## 配置建议

```text
webSearch.enabled
webSearch.provider = exa
webSearch.endpoint = https://mcp.exa.ai/mcp
webSearch.apiKey
webSearch.timeoutSeconds
```

## 验收标准

- [ ] 未配置 Exa 时，Agent 不会暴露不可用的 `web_search` 工具。
- [ ] 配置 Exa 后，可以通过 MCP 初始化并执行一次搜索。
- [ ] 搜索结果转换为 Iris 稳定的文本和 details，不泄露 provider 私有字段或 API key。
- [ ] 超时、断网、401、429、5xx 和非法 MCP 响应均有明确错误。
- [ ] 支持取消正在进行的搜索。
- [ ] 查询、结果数量和上下文大小受到限制。
- [ ] 不要求用户安装或启动 Docker、Python、Playwright 或本地 Gateway。
- [ ] 后续可以在不修改 Agent 工具 schema 的情况下增加 Parallel provider。

## 参考实现

- OpenCode `packages/core/src/tool/websearch.ts`
- Exa MCP endpoint：<https://mcp.exa.ai/mcp>
- MCP Streamable HTTP 协议
