---
title: codex hook
status: Done
---
Codex 官方支持在用户级 `~/.codex/hooks.json` 配置 `SessionStart`，无需修改
`config.toml`。Iris 现已将 Codex 纳入与其他 CLI 相同的检测、确认代写、备份与
更新流程。

安装后仍需通过 Codex 自带的信任审核：

* [ ] 在 Iris 设置的 Agents 页为 Codex 点击“代写 hook”。

* [ ] 新开 Codex 会话，运行 `/hooks` 并信任 Iris 的 `SessionStart` hook。

* [ ] 从 Iris 打开一个聚焦文档的 Codex 终端，确认会话启动时收到了
  `<iris-focus>` 上下文。

<br />

<br />

SessionStart hook (failed)

error: hook returned invalid session start JSON

output

## 修复总结

Codex 的 `hooks.json` 结构符合官方手册，失败来自共享脚本的纯文本输出以
`[Iris]` 开头。Codex 将开头的 `[` 当成 JSON 数组起始符后解析失败，
因此报 `invalid session start JSON`。本轮仍保留纯文本协议，将首行改为
`Iris:` 开头，避免触发 JSON 识别。

设置页的上下文注入状态同时补齐：

- `focus-context.ps1` 不再只检查“文件存在”，而是将盘上内容与当前
  内置脚本逐字比对，显示“未安装 / 旧版 · 可更新 / 最新”。
- 各 CLI hook 不再只检查是否出现 `focus-context.ps1`，而是检查 Iris
  handler 的类型和命令是否与当前定义一致，并显示“旧版 · 可更新”。
- 更新过期 hook 时，只原位重写命中 `focus-context.ps1` 的 Iris
  handler，保留 matcher、同组其他 handler 和其他 hook；写入前继续生成
  `.bak`。已是最新时不重写，也不产生无意义备份。
- 点击代写或更新 hook 时，若共享脚本未安装或已过期，会先将脚本
  更新到最新版。

自动验证：TypeScript 类型检查通过，Vitest 7 个测试文件、67 项测试全部通过。

- [ ] 重启开发版 Iris，确认 Agents 页将当前盘上旧脚本显示为
  “旧版 · 可更新”，更新后变为“最新”。

- [ ] 新开 Codex 会话，确认 `SessionStart` 不再报 JSON 错误，且收到
  `<iris-focus>` 上下文。
