---
title: iris agent模型问题
status: In Review
---
现在iris agent还是有一些问题的，最重要的就是选择模型之后没有保存，结果换一个窗口还是第一个模型，你现在要修复这个问题

## 修复记录

已实现：模型选择会持久化，新会话默认使用上次所选模型。

- 根因：`IrisAgentSessionManager.createSession()` 总是取 catalog 的第一个模型；换窗口 / 新 anchor 会新建 Session，于是忽略用户上次的选择（`setModel` 只写到该 Session 的 journal，不会影响新 Session）。
- 方案：机器级设置新增 `experimental.irisAgentDefaultModel`（存于 `~/.iris/settings.json`，所有窗口共享）：
  - `setModel()` 成功后把所选模型写为该默认值；
  - `createSession()` 优先使用该默认值（仍在 model catalog 中时），否则回退到第一个模型。
- 涉及文件：
  - `src/shared/types.ts` — `Settings.experimental.irisAgentDefaultModel`
  - `src/main/settings-manager.ts` — 默认值 + 校验
  - `src/main/agent/session-manager.ts` — 读取 / 写入默认模型
  - `src/main/app-main.ts` — 把 SettingsManager 注入 Agent manager
  - 测试：`settings-manager.test.ts` 新增校验用例（15/15 通过）；`session-manager.test.ts` 新增 3 项（本沙箱因 node-pty 原生模块缺失无法运行该测试文件，为既有环境问题，与本次改动无关）
- 待人工验收：
  - [ ] 真实环境选择一个模型后新建会话 / 换窗口，确认默认就是上次选的模型
  - [ ] 移除该 provider 凭证后新建会话，确认回退到第一个可用模型
