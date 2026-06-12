---
title: 调研:待办面板与标签元数据
---
# 调研:待办面板与标签元数据

应用户指示调研 `issue/2026-06-12-新功能:代办.md` 提出的两个方向,结论已写回该 issue 的「调研结论」一节。

做了什么:

- 通读读侧(`iris-scanner.ts`)、集合视图(`IssuePanel.tsx`、`collect-docs.ts`)与写回路径(`issue-actions.ts`、`markdown-utils.ts`),确认两个关键事实:扫描器本就全文读取每个文档,任务项提取零额外 IO;`setDocStatus` 的"读盘 → 行级手术 → doc.save"模式可直接平移到正文勾选。
- 查证 Linear 的 issue 属性全集(labels/priority/estimate/due date/assignee/project/cycle/relations 等),按 Iris 红线(无 schema、无注册表、软值)筛出建议抄的子集:labels(frontmatter 单行 flow 序列 + 词表从使用中推断)与可选的 priority。
- 确认定义书与路线图均未覆盖此功能——属新产品决策,整理出五个待用户拍板的问题,列于 issue 文末。

未动任何代码;等用户对入口位置、勾选交互、提取范围、标签范围与里程碑安排表态后再排实现。
