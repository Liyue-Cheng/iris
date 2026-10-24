---
title: 修复 Markdown 拖入图片后切换文档再返回时图片消失
status: In Review
---

## 问题

用户报告：将图片拖入 Markdown 文档，当时能看到图片，但切换到其他文档再返回后图片消失。需确认是图片引用未保存、资源路径解析错误，还是编辑器重建时图片加载失败。

## 调查与修复计划

1. 检查拖入/上传、资源文件落盘、Markdown 序列化与切换前保存的完整链路。
2. 检查重新打开时富文本编辑器及预览的图片 URL 解析，复现根因后修复。
3. 添加相关回归测试，运行必要检查，将实现与验证结果追加到本 issue。

## 根因与复现（2026-10-22）

已检查现有文档中的相对图片引用及对应 `.assets/` 文件，二者仍在。真实 Milkdown 编辑器测试成功复现：程序插入图片节点时能显示，序列化为 Markdown 后销毁编辑器，再用相同 Markdown 创建编辑器，图片节点消失。

原因是 Markdown 图片没有可选标题时，Remark 将 `title` 解析为 `null`。Milkdown 的块级图片解析器直接把它赋给 `caption`，但节点 schema 要求字符串。ProseMirror 抛出 `Expected value of type string for attribute caption on type image-block, got null`；Milkdown 捕获并记录错误，继续解析其他节点，因此表现为图片直接消失。行内图片的 `title` 属性也存在同样的问题，已通过测试复现。

## 修复结果

- 新增 [图片 schema 配置](../../src/renderer/lib/markdown-image-schema.ts)，在块级、行内图片进入原有解析器前，将缺省的 `title` / `alt` 归一化为空字符串。保留已有 schema 校验、图片标题、缩放比例和序列化逻辑，不修改依赖包。
- 在 [CrepeEditor](../../src/renderer/components/doc/CrepeEditor.tsx) 创建编辑器时注册配置，适用于切换文档、切换编辑模式和重新打开。
- 已有相对路径仍按文档位置加载，DOM 使用的 data URL 不写回 Markdown。现有文档及图片文件未作修改。

## 验证证据

- 新增 [编辑器重开回归测试](../../src/renderer/lib/markdown-image-reopen.test.ts)：使用真实 Milkdown/ProseMirror/Vue 编辑器，在 DOM 测试环境中执行插入、序列化、销毁、重建及修改周围文字后再次序列化。无标题图片在修复前失败，修复后通过；同时覆盖带标题图片、缩放比例、块级/行内图片共存，以及本地相对路径不被 data URL 替换。
- [资源管理测试](../../src/main/asset-manager.test.ts) 覆盖导入图片、保存 Markdown 后重新读取，确认中文和空格路径经 URL 编码后仍能读回相同图片字节。
- `npm test -- src/renderer/lib/markdown-image-reopen.test.ts src/main/asset-manager.test.ts src/renderer/lib/editor-session.test.ts src/renderer/lib/editor-store.test.ts src/renderer/lib/crepe-lifecycle.test.ts`：5 个文件、26 项测试全部通过。
- `npm run typecheck`：Node、preload、Web 类型检查及异步边界检查全部通过。
- `git diff --check`：通过。

未运行打包、安装更新或开发服务器截图。DOM 回归测试验证节点和图片 URL 恢复，不代替 Electron 中的实际图片解码与鼠标拖放验收。

## 待人工验收

- [ ] 在包含修复的 Iris 版本中导入无标题图片，切到其他文档再返回，确认图片仍显示。
- [ ] 编辑图片周围的文字并保存，再重新打开，确认图片引用和图片本身保留。
- [ ] 切换源码/富文本模式，确认块级、行内以及带标题图片均正常显示。

## 0.1.1 构建验证（2026-10-22）

用户随后要求提升版本并编译。修复已包含在 Windows x64 `0.1.1` 安装版和便携版中，
`npm run dist -- --win --x64 --publish never` 成功。全量 108 个测试文件、694 项测试通过；
类型／异步边界、元数据、许可证及 Agent Worker 检查通过。
包内 1,883 个构建文件与输出一致，生产 renderer 已确认包含图片 schema 配置及注册调用。
打包归档在隔离配置下通过隐藏窗口启动检查，preload 和页面就绪并运行 5 秒。

产物、校验和及验证范围见[开发与构建记录](../status/开发与构建.md#2026-10-22-本地构建-011)。
尚未安装新版本或验收实际拖放与图片显示；保留 `In Review`，上方人工验收项仍待完成。

## 迁移到上游修复（2026-10-24，0.1.2）

按用户授权，将 Milkdown/Crepe/Kit 全套升级为 7.22.3。该版本已包含上游 PR #2478 的缺省图片标题修复，原 `markdown-image-schema.ts` 临时兼容层及其注册已移除。保留图片重开与资源持久化测试，直接验证上游行为；当前全量 110 个文件、704 项测试通过，完整类型检查通过。

生产页面及打包验证记录统一写入[当前迁移 issue](./2026-10-22-优化界面.md)。前文 0.1.1 使用兼容层的记录保留为历史。
