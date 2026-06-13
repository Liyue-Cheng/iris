---
title: 编辑器块手柄做成设置项（默认隐藏）
status: Backlog
---
# 编辑器块手柄做成设置项

对应 issue：`issue/2026-06-12-MD.md`（已 done）。

## 做了什么

1. 研究手柄来源：Crepe `BlockEdit` 特性（默认开启）内的 `@milkdown/plugin-block`，悬停块左侧的 ＋/拖拽按钮组。闪动是 `transition: all 0.2s` 叠加我们 24px 水平 padding 不足（官方主题预期 120px），floating-ui 翻转/裁剪导致位置跳变。
2. 新增设置 `behavior.editorBlockHandle`（默认 `false`）：types + DEFAULT_SETTINGS + validateSettings。
3. 渲染端：`CrepeEditor` 读 settings-store，把值投影为容器 `data-block-handle` 属性；`global.css` 在 `off` 时 `display: none` 隐藏 `.milkdown-block-handle`。
4. 设置界面：外观分类新增「编辑器块手柄」开关，经 `settings.update` 指令提交，立即生效。

## 为什么这样做

- `Crepe.Feature.BlockEdit` 把手柄和斜杠菜单捆绑，整体禁用会误伤斜杠菜单；`blockHandle.shouldShow` 在 7.21.2 是声明未实现的死配置。CSS 隐藏是不碰 milkdown 内部、可即时切换的最薄方案。
- 默认关闭：issue 明确认为手柄多余且闪动。

## 验证

- `npm run typecheck` 三进程通过；`npm test` 43/43 通过。
- 旧 settings.json 缺新字段时由 deep-merge 自动补默认值，无迁移成本。

## 遗留

- 一次性会话误启动过一个带调试端口的 Iris 实例用于验证，已杀掉；临时目录 `.verify-tmp/` 已删除。
- 若未来想连悬停追踪开销一起去掉（而非仅隐藏），需等上游把 handle 与 slash menu 拆分或实现 `shouldShow`。
