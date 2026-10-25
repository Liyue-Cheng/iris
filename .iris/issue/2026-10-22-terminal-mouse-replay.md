---
title: 修复终端画面恢复后鼠标点击与滚动失效
status: Done
---

## 问题与调查证据

用户报告 Codex TUI 中鼠标点击、拖选文字和滚轮均无响应，按住 Shift 可以恢复文字选择。

已复现 Iris 的终端快照丢失鼠标编码：应用启用鼠标捕获和 SGR 编码后，经过当前 `TerminalMirror` 使用的 SerializeAddon 序列化并恢复，捕获模式仍在，但编码从 `SGR` 变为 `DEFAULT`。同步重放还会显式关闭 SGR 编码。xterm 的旧编码鼠标事件通过 `onBinary` 发出，而项目终端和 Agent 终端仅订阅 `onData`，导致点击和滚轮被捕获后丢弃。已核对当前安装版存在相同逻辑。

Shift 拖选绕过鼠标捕获，可恢复选择，与上述机制一致；尚未在修复后的应用中完成人工验收。

## 修复方案

1. 终端快照补齐鼠标编码状态，覆盖默认、SGR 和 SGR 像素编码；同步重放先清理旧状态，再恢复快照状态。
2. 项目终端与 Agent 终端都接入 `onBinary`，保留原始字节传至 PTY，避免高位坐标字节被 UTF-8 转换损坏。
3. 回归验证快照往返、编码切换、鼠标输入字节和中文键盘输入；运行相关测试与类型检查。
4. 将实现结果、实际验证证据和人工验收项追加到本 issue。

## 修复结果（2026-10-22）

代码修复完成，等待在包含本次修改的应用版本中人工验收。

- [TerminalMirror](../../src/main/terminal/terminal-mirror.ts) 在 SerializeAddon 快照后补齐鼠标编码：先清除旧的 SGR / SGR 像素编码，再恢复镜像的实际编码，保证新挂载和已有视图重同步都不会继承错误状态。
- [BrowserXtermAdapter](../../src/renderer/terminal/xterm-adapter.ts) 的同步重放重置补齐 `1016`；统一输入订阅同时接收 `onData` 和 `onBinary`，并在视图卸载时释放两者。
- 项目终端与 Agent 终端都通过统一订阅转发鼠标事件。项目终端的 base64 输入解码为 Buffer 后直接写入 PTY；Agent 终端的二进制输入以明确的 `encoding: binary` 标记，经主进程转换成 Buffer 后写入 PTY。普通中文输入仍按 UTF-8 传输。
- 保留正常的鼠标捕获语义：TUI 启用捕获时，普通点击/滚轮交给应用处理，Shift 拖选仍用于终端文字选择。

## 自动验证

1. 新增快照编码回归测试，修复前首轮出现 3 项失败；修复后默认、SGR、SGR 像素及关闭 SGR 后的恢复全部通过。测试使用实际 headless xterm，向恢复后的终端查询模式状态，并检查旧编码被替换。
2. 使用实际 browser xterm 输入事件验证文字与二进制通道均被订阅、保持编码标记，且释放订阅后不再转发。
3. 验证 `0xc8` / `0xff` 等旧格式鼠标坐标字节在传输及项目/Agent PTY 写入边界保持原值，同时覆盖中文输入。
4. `npm test -- src/main/terminal src/main/terminal-session-manager.test.ts src/main/agent/command-pty.test.ts src/renderer/terminal`：18 个文件、68 项测试全部通过。
5. `npm run typecheck`：Node、preload、Web 类型检查及 `check:async` 全部通过。
6. `git diff --check`：通过。

未执行打包、安装更新或开发服务器截图。自动测试验证了故障链和代码修复，不代表已完成当前安装版的鼠标交互验收。鼠标编码补齐使用 xterm 内部状态，与既有光标/滚动区域补齐相同；回归测试会在依赖升级导致该内部接口变化时暴露问题。

## 待人工验收

- [ ] 在包含本次修改的 Iris 版本中打开 Codex TUI，确认点击其支持鼠标操作的控件、滚轮滚动正常。
- [ ] 切换文档或终端再切回，并从历史/Shift 选择恢复实时画面，确认鼠标仍正常工作。
- [ ] 确认鼠标捕获期间 Shift 拖选可用，TUI 退出关闭捕获后普通拖选可用。
- [ ] 在 Agent 终端中关闭再打开终端面板，确认鼠标交互和中文键盘输入正常。

## 0.1.1 构建验证（2026-10-22）

用户随后要求提升版本并编译。修复已包含在 Windows x64 `0.1.1` 安装版和便携版中，
`npm run dist -- --win --x64 --publish never` 成功。全量 108 个测试文件、694 项测试通过；
类型／异步边界、元数据、许可证及 Agent Worker 检查通过。
包内 1,883 个构建文件与输出一致，生产输出已确认包含鼠标编码恢复及 `onBinary` 订阅。
打包归档在隔离配置下通过隐藏窗口启动检查，preload 和页面就绪并运行 5 秒。

产物、校验和及验证范围见[开发与构建记录](../status/开发与构建.md#2026-10-22-本地构建-011)。
尚未安装新版本或进行鼠标交互验收；保留 `In Review`，上方人工验收项仍待完成。
