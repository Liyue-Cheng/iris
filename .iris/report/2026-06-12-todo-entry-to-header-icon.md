---
title: 待办入口移入左栏头部图标簇
status: Backlog
---
# 待办入口移入左栏头部图标簇

验收迭代（来自 issue「新功能：代办」）：用户要求把左栏单独占一行的「待办」入口移到顶部图标排里。

改动（`src/renderer/components/layout/LeftPane.tsx`）：

- 删除树上方的整行「待办」按钮。
- 在头部图标簇（打开项目 / 新建工作区 / 裸树切换）中新增 ListChecks 图标按钮，置于「新建工作区」之前；右上角小角标显示未勾选任务计数（0 时隐藏）；`view.kind === 'todos'` 时高亮；tooltip 说明保留。

验证：三进程 typecheck 通过。逻辑未变（仍 `projectStore.openTodos(null)`），无需新增单测。
