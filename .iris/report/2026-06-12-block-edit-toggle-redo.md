---
title: 块手柄设置重做：改为 BlockEdit 特性整体开关
status: Backlog
---
# 块手柄设置重做：改为 BlockEdit 特性整体开关

对应 issue：`issue/2026-06-12-MD.md`。取代上一篇
`report/2026-06-12-block-handle-setting.md` 的 CSS 隐藏方案（report 只增不改，
故另起本篇）。

## 用户裁定

不要"CSS 只藏手柄、保留斜杠菜单"的折中——设置就做成 `BlockEdit` 特性的
整体开关。

## 做了什么

1. 设置项更名为 `behavior.editorBlockEdit`（默认 `false`），types +
   DEFAULT_SETTINGS + validateSettings 同步。
2. `CrepeEditor` 把该值传入 `features[Crepe.Feature.BlockEdit]`，并加入
   effect 依赖：Crepe 特性在创建时固定，开关变化按既有"generation 重挂"
   语义重建编辑器。设置视图替换三栏主体，开关翻转时编辑器必然未挂载。
3. 移除上一版的 `data-block-handle` 属性与 CSS 隐藏规则。
4. 设置界面文案改为「编辑器块编辑（BlockEdit）」，注明关闭时斜杠菜单一并禁用。

## 验证

`npm run typecheck` 三进程通过；`npm test` 43/43 通过。
