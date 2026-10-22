---
title: iris agent 右键菜单
status: Done
---
目前输入框的右键菜单还没有任何效果，你检查一下，然后实现一个完整的效果

## 定位

`IrisAgentView` 的输入框是原生 `<textarea>`，没有挂任何右键菜单，原因是两件事叠加：

- Electron 不会给文本框提供系统右键菜单，只有应用自己 `Menu.popup` 才有；
- 全项目的右键菜单都走 Radix `ContextMenuTrigger`，它在 `contextmenu` 事件里 `preventDefault()`，浏览器默认菜单同样被吞掉。

所以右键“完全没反应”。已有的 `ui/context-menu.tsx` 提供 `runAfterContextMenuClose`，`WINDOW_EDIT_ACTION` 也已经在给 Markdown 编辑器供能，缺的只是“文本框 + 菜单 + 命令”的接线。

## 方案

复用现有链路，不引入 Electron 原生菜单（保持主题一致）：

1. 新增可复用的 `TextEditContextMenu`（`src/renderer/components/ui/text-edit-context-menu.tsx`）：包住任意 `input`/`textarea`，菜单项为 撤销、重做、剪切、复制、粘贴、删除、全选。
2. 纯逻辑抽到 `src/renderer/lib/text-edit-menu.ts`：菜单打开瞬间快照选区（`selectionStart/End`、是否选中、是否有内容），据此计算各菜单项的禁用态。
3. 命令走已有的 `WINDOW_EDIT_ACTION` IPC，由 main 端 `webContents` 执行 `undo/redo/cut/copy/paste/delete/selectAll`；剪贴板与撤销栈都交给 Chromium，而不是在 React state 上重写一套。
4. 菜单会抢焦点，所以点菜单项时先用 `runAfterContextMenuClose` 把焦点和选区还给输入框，再发命令（与 `DocView` 的编辑器右键完全一致）。
5. 禁用态语义：`cut/copy/delete` 需要选区；`undo/redo/selectAll` 仅在输入框为空时禁用（Chromium 不暴露撤销栈状态，空框是唯一能确定的情况）；`paste` 始终可用。Agent 运行中输入框本身 `disabled`，此时右键不弹菜单。

## 实现结果

- `src/shared/protocol.ts`：`WindowEditAction` 扩展为 `undo | redo | cut | copy | paste | delete | selectAll`。
- `src/main/ipc.ts`：`WINDOW_EDIT_ACTION` 白名单同步新增 `undo/redo/delete` 分支。
- `src/shared/i18n/resources.ts`：新增 `common.undo` / `common.redo`（中英同步）。
- 新增 `src/renderer/components/ui/text-edit-context-menu.tsx` 与 `src/renderer/lib/text-edit-menu.ts`。
- `src/renderer/components/agent/IrisAgentView.tsx`：Agent 输入框包上 `TextEditContextMenu`，新增 `draftRef`。

## 验证

- `npx vitest run`：87 个文件、543 个测试全部通过（含新增 `src/renderer/lib/text-edit-menu.test.ts` 7 个用例）。
- `npx tsc --noEmit -p tsconfig.web.json`、`-p tsconfig.preload.json`：通过。
- `node scripts/check-async-boundaries.mjs`：通过。
- `npx tsc --noEmit -p tsconfig.node.json`：仅剩 `src/main/agent/session-manager.test.ts` 中 `IrisAgentContextUsage.revision` 一个报错，属于本 issue 之外的在途改动，与本次修改无关。

## 待确认

- [ ] 手工验收：在 Agent 输入框里选中文本 / 不选中文本分别右键，确认剪切、复制、粘贴、全选的可用状态与行为正确（尤其右键点选位置后粘贴的落点是否符合预期）。
- [ ] 确认是否把同一个 `TextEditContextMenu` 推广到其它原生输入框（Git 提交信息、设置页搜索框等）；目前只接了 Agent 输入框。

## 2026-09-09 决策更新

按用户决定取消「撤销 / 重做 / 删除」三项，菜单只保留 剪切、复制、粘贴、全选：

- `src/shared/protocol.ts`：`WindowEditAction` 回退为原来的 `cut | copy | paste | selectAll`。
- `src/main/ipc.ts`：`WINDOW_EDIT_ACTION` 白名单移除 `undo/redo/delete` 分支，恢复原有四分支。
- `src/shared/i18n/resources.ts`：移除新增的 `common.undo` / `common.redo`。
- `src/renderer/lib/text-edit-menu.ts`：禁用态简化为 `cut/copy` 需选区、`selectAll` 需非空、`paste` 恒可用。
- `src/renderer/components/ui/text-edit-context-menu.tsx`：菜单项收敛为四项，分隔线保留在「全选」之前。
- `src/renderer/lib/text-edit-menu.test.ts`：用例同步收敛为 7 个（仍是 7 个断言组，覆盖范围改为现有四命令）。

验证：`npx vitest run` 87 文件 / 543 测试全部通过；`tsc --noEmit` web 与 preload 通过；`check:async` 通过；`tsconfig.node.json` 仍只剩 `session-manager.test.ts` 的 `IrisAgentContextUsage.revision` 报错（本 issue 之外的在途改动）。
