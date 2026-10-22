---
title: terminal rg支持情况
status: Done
---
我们现在的terminal好像没有支持rg，这是怎么回事？

## 结论（2026-09-10）

terminal 里没有「支持某个命令」的开关，它只是把命令原样交给用户 shell 执行。本机 PATH 里
没有 `rg`，所以项目终端、Iris Agent terminal、外部 pwsh 都跑不了 `rg`——报的是「命令不存在」，
不是被 Iris 拦住或没实现。

### 排查证据

**1. 本机确实没有安装 ripgrep。**

* `rg --version` 在 Iris 终端里返回 PowerShell 的 CommandNotFoundException（`The term 'rg'
is not recognized as a name of a cmdlet, function, script file, or executable program`）。
* 常规安装位置逐个探测全部不存在：`~\scoop\shims`、`%LOCALAPPDATA%\Microsoft\WinGet\Links`、
  `%ProgramData%\chocolatey\bin`、`~\.cargo\bin`、`C:\Program Files\ripgrep`、
  `C:\Program Files\Git\usr\bin`、`~\.local\bin`。
* 仓库内也没有：`node_modules\.bin` 无 `rg`/`grep` 拷贝。
* 注册表层的 user PATH 与 machine PATH 里都没有任何可能装着 rg 的目录，说明**不是 Iris 丢了
  PATH，而是 PATH 本身就没有**。

**2. Iris 不打包、也不注入任何二进制。**

* `electron-builder.yml` 的 `extraResources` 只有 `LICENSE` 和 `THIRD_PARTY_NOTICES.txt`，没有
  任何可执行文件。
* 项目终端：`terminal-session-manager.ts:284` 用 `buildSpawnEnv(process.env, SPAWN_ENV_SKIP)`
  直接继承主进程环境，只跳过 `ELECTRON_RUN_AS_NODE` 和 `ELECTRON_RENDERER_URL`；系统终端
  （`system-terminal.ts:49`）同样。
* Agent 终端：`pi-adapter.ts:192` 传 `env: process.env`，`tool-host.ts` 的 `sanitizeEnv` 再在
  `process.env` 之上合并调用方传值。
* 全仓没有把 `<resources>/bin` 之类目录前置到 spawn env PATH 的代码（`PATH` 相关命中只有
  「探测哪个 shell 可用」的 `pathDirs`）。

**3. terminal 不做命令过滤。**

* `commandShell()`（`command-pty.ts:293`）和 `resolveHostShell()`（`terminal-session-manager.ts:166`）
  只决定用哪个 shell（Windows：pwsh → powershell → cmd；POSIX：`$SHELL` → `/bin/bash`），命令
  字符串原样传给 `-Command` / `-lc`。
* 全仓没有 allow/deny/forbidden 命令名单（`dangerousPaths` 命中的是粘贴/拖入的**文件名**安全确认，
  不是命令策略）。

**4. 为什么「别的 agent 都有 rg」。**

* 本机 Cursor 自带 `C:\Program Files\cursor\resources\app\node_modules\@vscode\ripgrep\bin\rg.exe`
  （4.2 MB）；VS Code / Claude Code 同样各自携带一份，不依赖 PATH。
* `.iris/iris-agent/issue/2026-09-09-iris上下文水位指示器没生效.md` 里那些成功的 `rg -n ...` 是 Claude Code
  会话的 transcript，`rg` 来自它自己带的二进制——这条很容易被读成「Iris 终端以前支持 rg」。
* Iris Agent 现在是四工具小核心（`read`/`edit`/`write`/`terminal`），没有独立搜索工具，搜索全靠
  terminal 完成，见 `.iris/iris-agent/issue/2026-09-06-工具列表.md` §12.5。

**5. 两个容易被误判成「不支持」的细节。**

* Agent 终端是 `pwsh -NoLogo -NoProfile -Command`（`command-pty.ts:302`，项目内交互终端是 `terminal-session-manager.ts:183` 的 `-NoExit` 形式）：**PowerShell profile 里的 PATH 追加、别名、函数对 Agent 终端不可见**，
  项目内终端会加载 profile。将来若用 profile 补 PATH，只对普通终端生效。
* `rg` 无匹配时退出码是 1，而 terminal 的 `successExitCodes` 默认是 `[0]`（`pi-adapter.ts:181`），
  所以即使装好 rg，`rg -n foo` 的空结果也会被记成「失败」。这点 `2026-08-20-iris-agent显示效果优化.md:123`
  已经记过一次，属于命令语义与工具成功码的错配，不是 rg 本身的问题。

### 如果你问的是「正则」而不是 ripgrep

那是一个真实的功能缺口，但和 PATH 无关：终端搜索（Ctrl+F）只传了 `caseSensitive`
（`TerminalView.tsx:230-241`，`TerminalSearchBar.tsx` 也没有正则开关），而 `@xterm/addon-search`
的 `SearchOptions` 本身支持 `regex: boolean`。需要的话可以单独做一个小改动。

### 可选方案（等拍板）

* **A. 不改代码，本机装一份。** `winget install BurntSushi.ripgrep.MSVC`（或 scoop / choco / cargo）。
  装完要**重启 Iris**，因为终端继承的是 Iris 启动时的 PATH。零风险、立刻可用；缺点是只解决这台机器。
* **B. 随应用打包 ripgrep。** `extraResources` 里加各平台 rg，启动时把 `<resources>/bin` 前置到
  两类终端的 spawn env PATH——这就是 VS Code / Cursor / Claude Code 的做法。一次安装人人可用；
  成本是每平台一份二进制、体积、许可证与 `THIRD_PARTY_NOTICES.txt` 更新、打包脚本改动。
* **C. 把搜索升级成一等工具。** 新增 `grep`/`glob` 工具（内置 ripgrep，返回结构化匹配、路径、行号），
  让模型不再靠 shell 搜索。工作量最大，但和 `.iris/iris-agent/issue/2026-09-06-工具列表.md` §12.5 以及
  「未来专用 search/grep 工具」（`2026-08-20-iris-agent显示效果优化.md:178`）的路线一致。

建议顺序：A 先解掉当下的阻塞（不改代码），B/C 作为产品决策；若选 C，可以顺手做 B 的 PATH 注入，
让 grep 工具和终端共享同一份二进制。无论哪条路，都建议把「rg 空结果是成功」的语义一起定下来
（改默认成功码，或在 terminal 工具描述里写明需要 `successExitCodes: [0,1]`）。

### 待拍板

- [ ] 确认问题指的是 ripgrep（PATH 里没有）还是终端搜索的正则支持？
- [x] 选 A（本机安装 ripgrep，不改代码）—— 2026-09-10 已执行，见下方「处理结果」。
- [x] 选定方案后是否需要我落地实现 —— A 方案不需要改代码，已直接安装；`successExitCodes` 空结果语义仍未决定，见下方待办。

## 处理结果（2026-09-10）

按 A 方案在本机安装 ripgrep，**未改动任何仓库代码**。

### 做了什么

```powershell
winget install --id BurntSushi.ripgrep.MSVC --scope user --accept-source-agreements --accept-package-agreements
```

* 版本 **ripgrep 15.2.0**（rev e89fff89ac），feature `+pcre2`，PCRE2 10.45 可用且带 JIT。
* 安装方式：winget portable 包，`--scope user`，免 UAC。
* 实际二进制：`%LOCALAPPDATA%\Microsoft\WinGet\Packages\BurntSushi.ripgrep.MSVC_Microsoft.Winget.Source_8wekyb3d8bbwe\ripgrep-15.2.0-x86_64-pc-windows-msvc\rg.exe`
* winget 建立了命令别名符号链接：`%LOCALAPPDATA%\Microsoft\WinGet\Links\rg.exe`，并把
  `%LOCALAPPDATA%\Microsoft\WinGet\Links` **追加到用户级 PATH**（注册表 `HKCU\Environment\PATH` 已确认，追加在末尾）。

### 验证

* `& "$env:LOCALAPPDATA\Microsoft\WinGet\Links\rg.exe" --version` → 正常输出 `ripgrep 15.2.0`。
* 在项目根用它实际搜了一把：`rg -n "resolveUnrestrictedPath" src/main/agent/tool-host.ts` →
  返回 114 / 201 / 263 三行，中文、路径、行号均正常。
* `rg.exe` 是符号链接，目标存在且可执行；PATH 条目拼写已核对无误。
* **重启后的效果已预先模拟验证**：把当前进程 PATH 换成「machine PATH + user PATH」的组合
  （即重启后 Iris 会继承的完整环境）后，bare `rg` 直接解析到
  `C:\Users\liyue\AppData\Local\Microsoft\WinGet\Links\rg.exe`，`rg --version` → `ripgrep 15.2.0`，
  `rg -n --no-heading "resolveHostShell|commandShell" src/main/agent/command-pty.ts` 正常返回
  49 / 129 / 293 三行。所以重启后不需要任何额外配置。

（一个与本次安装无关的 Windows 使用提醒：`rg -n foo .iris/status/*.md` 这种写法会报
`os error 123`，因为 rg 不自己展开 `*`；写成 `rg -n foo .iris/status` 或加 `--glob '*.md'` 即可。
之前 `.iris/iris-agent/issue/2026-09-09-iris上下文水位指示器没生效.md` 里记的同类报错就是这个原因，不是安装问题。）

### 还需要你做一件事：重启 Iris

**当前这个 Iris 进程里 `rg` 仍然不可用**，这不是安装失败：终端 spawn 时继承的是
Iris 主进程启动那一刻的 `process.env`（见上文证据 2），而 PATH 修改对已运行进程无效。
实测本会话 PATH 里确实还不含 `WinGet\Links`，`rg --version` 依然报 CommandNotFoundException。

因此：**完全退出 Iris 再重新打开**，新开的项目终端、工具栏命令和 Iris Agent 的 terminal 就都能用 `rg` 了。
（在旧窗口里临时救急可以 `$env:PATH += ";$env:LOCALAPPDATA\Microsoft\WinGet\Links"`，但只对那一个终端的后续命令有效。）

### 这个方案的影响面

* 只解决这台机器：其他人 / 另一台机器上仍然是「命令不存在」，B/C 未做。
* 不改仓库，所以 `THIRD_PARTY_NOTICES.txt`、`electron-builder.yml`、打包流程都不受影响。
* winget 会随 rg 的升级包更新符号链接，无需手工维护。

### 遗留待办

- [ ] 完全退出并重启 Iris，然后在项目终端执行 `rg --version` 确认 bare `rg` 可用。
- [ ] 在 Iris Agent 的 terminal 里跑一次 `rg -n "resolveUnrestrictedPath" src/main/agent/tool-host.ts`，确认 Agent 终端（`-NoProfile`）同样能用。
- [ ] 决定 rg「无匹配退出码 1」的语义：是改 terminal 默认 `successExitCodes`，还是只在描述里提示用 `successExitCodes: [0,1]`（目前空结果会被记成失败）。
- [ ] 若要覆盖其他机器 / 别的用户，另行决定是否做 B（随应用打包并注入 PATH）或 C（新增 grep、glob 工具）。
