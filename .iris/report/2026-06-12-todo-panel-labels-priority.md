---
title: 实现待办面板与 Linear 式元数据（labels / priority）
status: Backlog
---

# 实现待办面板与 Linear 式元数据

对应 issue：`issue/2026-06-12-新功能：代办.md`（用户授权按调研结论自行裁决遗留产品决策）。

## 做了什么

- 读侧零新增 IO：`extractTodos`（shared/markdown-utils，纯函数 + 单测）在 scanner 既有的全文读取上逐行字面提取 GFM 任务项，fenced code 按 CommonMark 围栏规则确定性跳过；`labels:` 字面投影（序列 → 项，单标量 → 单元素）。两者随 `IrisDoc` 进扫描结果，chokidar 回路天然保持实时。
- `TodoPanel`（中栏新视图 `kind: 'todos'`）：活动 issue 的未勾选任务按来源分组；左栏树上方固定入口 + 计数。
- 勾选写回（`lib/todo-actions.ts`）：单行字节手术，写前与扫描记录的原文比对，不一致拒绝；目标文档在编辑器打开时先 flush，再让既有 doc-projection ISR 重载干净会话。复用 `doc.save`，未发明新副作用通道。
- 标签：issue 面板标签列（chip 点击过滤）、TypedHeader 标签编辑（候选 = 全项目并集，无注册表/无管理 UI）、颜色 = 名字哈希 → Rose Pine 强调色；frontmatter 写单行 flow 序列以保住行级手术与零 diff。
- 优先级：`priority:` 软值字段（urgent/high/medium/low 候选、自由值放行），面板列 + 下拉编辑（`setDocField` 由 setDocStatus 泛化而来）、TypedHeader 字段、活动列表优先级排序。

## 为什么这样做

- 文件即契约：待办不是新数据模型，只是正文任务项的投影；标签词表不建注册表，集合 = 实际使用的并集（红线：结构从文件系统推断）。
- 写侧只做拒绝式校验（盘上原文 ≠ 扫描快照即放弃），零启发式，符合中断/去重纪律。

## 验证

vitest 43 通过（新增 extractTodos、flow-seq 读写、scanner 投影用例 + 边角夹具）；三进程 typecheck 干净；build + 启动冒烟通过。手工验收清单建议：待办面板勾选后行消失且源文档仅该行变更；编辑器打开同一文档时勾选不丢编辑；标签增删的 frontmatter diff 仅一行；issue 面板按优先级排序。
