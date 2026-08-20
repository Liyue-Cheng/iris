---
title: iris agent模型问题
status: In Review
---
现在iris agent还是有一些问题的，最重要的就是选择模型之后没有保存，结果换一个窗口还是第一个模型，你现在要修复这个问题

## 修复记录

已实现：模型选择会持久化，新会话默认使用上次所选模型。

* 根因：`IrisAgentSessionManager.createSession()` 总是取 catalog 的第一个模型；换窗口 / 新 anchor 会新建 Session，于是忽略用户上次的选择（`setModel` 只写到该 Session 的 journal，不会影响新 Session）。

* 方案：机器级设置新增 `experimental.irisAgentDefaultModel`（存于 `~/.iris/settings.json`，所有窗口共享）：

  * `setModel()` 成功后把所选模型写为该默认值；

  * `createSession()` 优先使用该默认值（仍在 model catalog 中时），否则回退到第一个模型。

* 涉及文件：

  * `src/shared/types.ts` — `Settings.experimental.irisAgentDefaultModel`

  * `src/main/settings-manager.ts` — 默认值 + 校验

  * `src/main/agent/session-manager.ts` — 读取 / 写入默认模型

  * `src/main/app-main.ts` — 把 SettingsManager 注入 Agent manager

  * 测试：`settings-manager.test.ts` 新增校验用例（15/15 通过）；`session-manager.test.ts` 新增 3 项（本沙箱因 node-pty 原生模块缺失无法运行该测试文件，为既有环境问题，与本次改动无关）

* 待人工验收：

  * [ ] 真实环境选择一个模型后新建会话 / 换窗口，确认默认就是上次选的模型

  * [ ] 移除该 provider 凭证后新建会话，确认回退到第一个可用模型

* <br />

<br />

现在agent的显示效果我认为还是有些问题

25327 bytes E:\projects\iris · PowerShell 7 (pwsh.exe): exit 0, 857 bytes

这些不要显示

每一个信息获取，显示成功和失败，失败原因可以展开就行了

<br />

rg -n "new SettingsManager|JsonStore" src/main/settings-manager.test.ts | Select-Object -First 10; rg -n "settings-manager" vitest.config.ts package.json

E:\projects\iris · PowerShell 7 (pwsh.exe): exit 1, 229 bytes

\[?9001h\[?1004h\[?25l\[2J\[m\[H4:import type { JsonStore } from './persistence'; ]0;C:\Program Files\PowerShell\7\pwsh.exe\[?25h75:    } as unknown as JsonStore\<Settings>; 76:    const manager = new SettingsManager(store);   Command exited with code 1

<br />

命令失败的回显渲染不正确

<br />

命令出现非预期的失败\
npm test -- --reporter=dot src/main/agent/session-manager.test.ts 2>&1 | Select-Object -Last 30

\[?9001h\[?1004h\[?25l\[2J\[m\[H]0;C:\Program Files\PowerShell\7\pwsh.exe\[?25h]0;npm]0;npm test --reporter=dot src/main/agent/session-manager.test.ts]0;C:\WINDOWS\system32\cmd.exe ]0;node (vitest)]0;C:\Program Files\PowerShell\7\pwsh.exe\[?9001l\[?1004l Command exited with code -1073741510

<br />

```
npx tsc --noEmit -p tsconfig.node.json 2>&1 | Select-Object -Last 20; Write-Host "node-exit=$LASTEXITCODE"
```

Interactive terminal commands are not supported in this Iris Agent milestone.

对交互式命令的识别不正确

<br />

然后是现在时间很长的命令还是无法正确处理，你看看之前的产品决策，理解应该怎么做
