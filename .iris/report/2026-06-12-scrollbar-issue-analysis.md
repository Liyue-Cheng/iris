---
title: 滚动条 issue 的成因分析与方案写回
status: Backlog
---

应用户要求分析 `issue/2026-06-12-markdown编辑器的进度条问题.md` 并把结论追加回该文档。

定位结论：抖动来自 `CrepeEditor` 滚动容器 `overflow-y: auto` 的滚动条出现/消失改变内容区宽度，使 48rem 居中正文列水平平移；"没主题"是因为 `global.css` 完全没有滚动条样式规则，全 app 用的都是 Chromium 原生滚动条。

写回内容：成因分析 + 两步实现方案（`scrollbar-gutter: stable both-edges` 治抖动；全局 `::-webkit-scrollbar` 映射主题 token 治样式）+ 验收点。仅分析与写回，未改代码，issue 状态保持 `todo`。
