---
title: iris agent 可观测性
status: In Review
---
输入卡片和最终输出卡片，右上角都要有一个按钮，点击之后显示完整提示词，用默认程序打开

## 实现方案

* 在每个 turn 发送前，把实际交给 Agent Worker 的完整 prompt 快照写入 app-owned `userData`；turn 只记录快照可用标记，避免每次流式更新都把大段 prompt 经 IPC 重复广播到 Renderer。
* 增加按 project scope、session 和 turn 校验的打开接口。主进程根据不可伪造的内部路径定位快照，再调用操作系统默认程序打开 `.txt` 文件；Renderer 不传任意文件路径。
* 输入卡片始终显示“打开完整提示词”图标按钮；assistant 只有在 turn 完成、成为最终输出后显示同一按钮。两个入口打开该 turn 在发送时保存的同一份历史快照，不使用点击时的最新文档重新组装。
* 旧会话没有 prompt 快照标记时不显示按钮；Rewind 保留目标 turn 的快照可用性并截断后续界面记录。
* 增加存储、IPC/manager 和 Renderer 静态渲染测试，并运行 typecheck 与相关 Vitest；不运行 build、dist 或开发服务器截图。

## 实现结果

* 每个新 turn 会在发送前原子保存实际传给 Agent Worker 的完整 prompt；Session 只广播 `promptAvailable`，流式消息刷新不会反复携带 prompt 正文。
* 新增 `iris-agent:open-prompt` 主进程通道，先校验当前 project scope、session 和 turn，再从 app-owned 存储目录解析哈希路径并调用 `shell.openPath`。Renderer 无法指定任意本机路径。
* 输入卡片右上角显示文件图标按钮；只有 `completed` assistant 最终输出显示同一按钮。旧 Session、流式输出、失败或停止的非最终输出不显示按钮。
* Rewind 会按既有规则截断后续 turn，同时保留目标 turn 的 prompt 可用标记和历史快照。

## 验证结果

* `npm run typecheck` 通过，包含 node、preload、web TypeScript 和 async boundary check。
* 定向运行 Agent Session store、manager 和 Renderer 3 个测试文件，共 5 项测试全部通过。覆盖 prompt 快照跨重启、Rewind、卡片顺序、双入口和流式输出单入口。
* `git diff --check` 通过，仅有仓库既有的 Windows LF/CRLF 提示。
* 全量测试未作为通过证据：既有 `project-init` 套件在 Windows 原子写入路径出现 5 秒超时，串行复跑结果为 17 项中 14 项通过、3 项超时；本次涉及的定向套件均通过。
* 按项目要求未运行 build、dist，也未用开发服务器截图代替人工测试。

- [ ] 在 Windows 产品界面完成一个 Iris Agent turn，分别点击输入卡片和最终输出卡片按钮，确认两者由默认文本程序打开同一份完整 prompt，内容含 Agent、software、project、anchor 和 user-request 层。

## 2026-08-16：手工验证发现语义缺口

“完整提示词”当前实现只保存 `preparePrompt()` 生成的本轮 assembled user prompt。它包含 Agent、software、project、anchor 和本轮 `user-request`，但不包含 Pi Session 已持有的历史消息，因此不能代表或证明实际 provider 请求的完整上下文。

现场在 Stop 后发送“继续”：app-owned Session store 已保存上一轮 1,682 字 assistant partial，但“继续”turn 的快照不包含该历史正文。另确认 Worker 初始化虽然收到 `history.messages`，当前实现并未把它注入 Pi Session，空闲退出或重启后的历史恢复尚未成立。

- [ ] 决定入口的准确产品语义：若目标是本轮 assembled user prompt，修改按钮、文案和 Issue 中“完整”的表述；若目标是 provider 完整上下文，改为捕获 system prompt、历史消息、本轮消息、工具 schema 及必要裁剪事实的结构化快照。

- [ ] 增加包含历史的第二 turn 验收，确认打开的内容与真正送入 provider 的上下文一致，而不只检查静态层和本轮 `user-request`。

- [ ] 在上述语义缺口修复并完成产品手工验证前，本 Issue 不应转为 Done。
