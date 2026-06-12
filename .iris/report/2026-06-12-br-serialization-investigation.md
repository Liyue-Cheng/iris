---
title: `<br />` 序列化问题调查
---

# `<br />` 序列化问题调查(2026-06-12,agent)

**做了什么**:用户在 `issue/2026-06-12-bug修复.md` 等文档中发现正文出现 `<br />` HTML 片段,要求查证原因。先在本地 `node_modules` 源码中定位,再以 Milkdown 上游 issue/PR 交叉验证,确认根因后将调查结论与候选方案写回该 issue 文档(用户决定先记录、未来再修)。

**结论**:`<br />` 是 Milkdown 有意的设计——paragraph `toMarkdown` 把"空段落且非末节点"序列化为 `<br />`,`remarkPreserveEmptyLinePlugin` 加载时还原,用于保住用户敲出的视觉空行(上游 issue #1579 / PR #1765,crepe 7.21.2 默认启用)。与本项目"纯 CommonMark、文件即契约"约定冲突,属产品取舍而非库 bug。候选方案与待办见 issue 文档,未拍板、未动代码。

**为什么只记录不修**:用户明确指示"先写一下,未来再处理";且方案选择(剥掉 `<br />` vs 接受 HTML 噪音)是定义书未覆盖的产品决策,需用户拍板。
