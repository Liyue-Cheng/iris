---
title: Codex 光标闪动根因与 Marina 修复指引
status: Active
---

# 结论

Iris 与 Marina 在 Windows 上只设置 `useConpty: true` 时，`node-pty` 默认使用
系统 ConPTY。Codex TUI 的帧尾顺序是 `Show -> MoveTo`，系统 ConPTY 会把最终
光标移动重编码成稍后到达的 `Hide -> MoveTo -> Show` 修正包，使 xterm 先呈现
一次错误的中间光标位置。

Iris 已在 Windows PTY spawn 选项中启用 bundled ConPTY DLL：

```ts
useConptyDll: process.platform === 'win32'
```

该 DLL 保留 Codex 的 synchronized-output 边界，xterm 不再呈现中间状态。用户
已在原 Codex 持续输出场景中复测，确认闪动消失。

# 根因证据

受控 A/B 使用同一个 `node-pty 1.1.0`、子进程和终端尺寸，仅切换
`useConptyDll`：

- `false`：系统 ConPTY 提前输出已经结束 synchronized update 的重绘，约
  12 ms 后再输出光标修正包，两个位置都会被 xterm 呈现。
- `true`：bundled DLL 保留原始输出边界，最终 `MoveTo` 与同步输出结束仍在正确
  的边界内，中间光标位置不可见。

这也解释了同机 VS Code 的差异：该实例通过实验配置实际启用了随包携带的
ConPTY DLL，而不是系统 ConPTY。问题不在 xterm WebGL 双画布、xterm 版本或
Iris 的 8 ms 数据合批。

# Marina 需要同步的修改

Marina 当前仍在 `src/main/session-manager.ts` 的 spawn options 中只传入：

```ts
useConpty: true
```

同步修复需要两处小改动：

1. 在本地 `PtySpawnFn` 的 options 类型中加入
   `useConptyDll?: boolean`。
2. 在 `SessionManager` 调用 `this.spawnFn(...)` 的 options 中加入
   `useConptyDll: process.platform === 'win32'`。

Marina 的 `electron-builder.yml` 已用 `asarUnpack` 保留整个
`node_modules/node-pty/**`，其 `node-pty 1.1.0` 包也包含所需的
`conpty.dll` 与 `OpenConsole.exe`，因此不需要另加运行时依赖或复制资源。

# Marina 验证清单

- [ ] `npm run typecheck` 与 SessionManager 相关测试通过。
- [ ] Windows 开发版中新建、resize、关闭本地 shell 均正常。
- [ ] 使用当前 Codex 持续输出并输入，确认输入区光标不再闪到绘制中的位置。
- [ ] 检查 Windows 打包产物中的 `node-pty` bundled ConPTY 资源可加载，并在安装版或便携版重复 Codex 场景。
- [ ] 若要支持较旧 Windows，验证目标系统的 DLL 加载行为；只有出现真实兼容性故障时再设计显式回退。

# 不建议的替代方案

不要先在 xterm 侧识别并吞掉特定的光标序列。该做法依赖 Codex 当前输出形态，
容易破坏其他 TUI 的合法光标语义；切换 ConPTY 后端是在产生中间状态的边界上
修复问题，影响范围更清晰。
