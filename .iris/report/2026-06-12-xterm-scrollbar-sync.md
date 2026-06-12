---
title: 终端滚动条与编辑器同步
---

# 终端滚动条与编辑器同步

接 `report/2026-06-12-scrollbar-theming-and-jitter-fix.md`：用户反馈终端与
编辑器滚动条外观仍不一致。排查后发现上一轮的核对结论有误——项目安装的是
xterm **6.1.0-beta**，6.x 已把视口滚动条从原生 `.xterm-viewport` webkit
滚动条重写为 vscode 风格的 DOM 自定义滚动条（`.xterm-scrollable-element`），
`::-webkit-scrollbar` 伪元素无法作用于它。

本轮改动：

1. `src/renderer/theme/xterm-themes.ts` — 三个主题各新增
   `scrollbarSliderBackground/Hover/Active`（取 highlight-med /
   highlight-high / muted 字面量，与 global.css token 手工对齐）和
   `overviewRulerBorder` = 背景色。后者是因为给 xterm 设 `scrollbar.width`
   会顺带实例化 overview ruler，它无条件画一条 1px 边线，用背景色隐形。
2. `src/renderer/components/terminal/TerminalView.tsx` — Terminal 选项加
   `scrollbar: { width: 10 }`，宽度与全局 webkit 滚动条对齐。
3. `src/renderer/styles/global.css` — 给 `.xterm-slider` 补 2px 透明
   border + 5px 圆角 + `background-clip: content-box !important`（xterm
   运行时注入 `background` 简写会重置 clip），做出与编辑器一致的 6px
   细条；同时修正上一轮注释里"xterm-viewport 可被全局规则覆盖"的错误。

保留的差异（设计使然）：终端滚动条是 vscode 式覆盖层，滚动/悬停显示、
闲置淡出（xterm 6 写死 `ScrollbarVisibility.Auto`，无选项），不占布局
故无抖动；编辑器为常驻原生滚动条。

`npm run typecheck` 通过。issue 维持 `in_progress`，验收点已在 issue 内
追加，等手工验收后置 `done`。
