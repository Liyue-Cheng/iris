---
title: 滚动条主题化与编辑器抖动修复
---

# 滚动条主题化与编辑器抖动修复

按 `issue/2026-06-12-markdown编辑器的进度条问题.md` 中既有方案实施，改动仅
`src/renderer/styles/global.css`：

1. `.crepe-host` 增加 `scrollbar-gutter: stable both-edges`。滚动条空间
   常驻且两侧对称预留，48rem 居中正文列在滚动条出现/消失时不再水平平移。
2. 新增全局 `::-webkit-scrollbar` 规则组：宽 10px，track 与 corner 透明，
   thumb 取 `var(--rp-highlight-med)`、hover 升 `var(--rp-highlight-high)`，
   以 `background-clip: content-box` + 2px 透明 border 呈现 6px 细条但保留
   完整命中区域。经 `--rp-*` 间接，三个 Rose Pine 变体自动跟随主题。

为什么不用标准 `scrollbar-width`/`scrollbar-color`：在 Chromium 中设置任一
标准属性会令整组 `::-webkit-scrollbar` 失效，且无 hover 态与圆角。

核对项：xterm 自带 CSS 的 vscode 风格自定义滚动条默认不启用，实际滚动条在
`.xterm-viewport` 的原生 webkit 滚动条上，全局规则可覆盖，无需单独处理。

issue 状态已置 `in_progress`，待用户按 issue 内验收点手工验收后置 `done`。
