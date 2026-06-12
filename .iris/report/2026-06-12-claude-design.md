---
title: claude design — 设计系统同步与提示词
date: 2026-06-12
---

# claude design — 设计系统同步与提示词

针对 issue「claude design」做了两件事：

1. **同步设计系统到 claude.ai/design**：从 `src/renderer/styles/global.css`（双层 token）、`components/ui/`（shadcn 拷贝件）与实际组件（IssuePanel、LensTree、TypedHeader）提取设计语言,生成 8 张自包含 HTML 预览卡 + README,上传为设计项目「Iris 设计系统」。卡片覆盖:三变体色板、语义 token 映射、字体排版、按钮、状态徽章与会话状态点、菜单弹层、issue 面板、透镜树。真理源仍在仓库,设计项目是只读镜像,token 改动后需手动重传。
2. **撰写 Claude Design 提示词**：按 issue 正文要求,把可直接粘贴的完整重设计提示词写回该 issue——含产品世界观、设计语言硬约束、三栏信息架构、按优先级的八项待设计界面清单（设置页列为第一,对应「首次使用体验报告」的痛点）与输出要求。

issue 已标 done。后续:在 claude.ai/design 打开「Iris 设计系统」项目,粘贴提示词开始设计;产出回到代码时遵守 token-only 约束。
