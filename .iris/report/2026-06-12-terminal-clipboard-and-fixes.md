---
status: Backlog
---
# 2026-06-12 终端复制粘贴与抖动修复

针对 `issue/2026-06-12-终端复制粘贴.md`（$FOCUS_DOC）的实现会话。

## 做了什么

1. **全面调研**：逐行对比 Iris 与 Marina（`E:\projects\terminal`）的终端层，结论追加在 issue 内。核心发现：Iris 只移植了 Marina 的骨架（state-replay、静默窗口、headless 镜像），交互层（剪贴板、键位、resize 纪律、replay 视口、IME workaround）全部缺失；"复制粘贴没反应"的直接根因是 Ctrl+V 被 xterm 编码成 0x16 发给 PTY；"进度条画花"来自 resize 无防抖 + 120×30 占位 spawn 的 ConPTY reflow。
2. **实现**：剪贴板 IPC 桥、键位权威表（+单测）、capture-phase paste 拦截器、右键菜单、选中即复制、resize 防抖/守卫/真实尺寸 spawn、replay 分片+锚底+隐藏首帧、IME-1/IME-2 照搬、WebLinksAddon、WebGL context-loss 回退、webfont re-fit。明细与两处有意偏差（`term.paste()` 代替手工 bracketed 包裹；原生 confirm 代替 Modal）见 issue 实现记录。

## 为什么这样做

- CLAUDE.md 复用纪律：会话层"不重写，复制后小改"。两边 xterm 同为 6.1.0-beta.256，Marina 的 workaround（含走 `_core` 私有 API 的 IME-2）可以安全照搬，全部带特性检测降级。
- 偏差只在 Marina 方案依赖 Iris 没有的基建时发生（settings.behavior、Modal、Toast），且都选了更保守的替代。

## 验证

`npm run typecheck`、`vitest`（34 过）、`npm run build`、`npm run smoke` 全过。未提交代码；issue 留了 ✋ 手工验收清单，过验收前 status 保持 in_progress。

## 留给后续的

- 终端搜索栏（Ctrl+F + SearchAddon）；行为设置项（selectOnCopy / 右键模式 / bracketedPaste）；输入被拒 toast。均记录在 issue"已调研、本次不做"。
