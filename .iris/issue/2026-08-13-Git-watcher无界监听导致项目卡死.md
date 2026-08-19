---
title: Git watcher 无界监听导致项目卡死
status: In Progress
---

## Issue 定义

Iris 在 Windows 上打开包含大型 ignored 目录的 Git 项目时，Electron main 进程会因 Git watcher 无界递归监听而失去响应。该问题阻塞 Iris Agent 第一轮手工测试，但根因位于 Git 自动刷新边界，不是 Git 命令或 Agent Session。

## 已确认现象

环境：

* 项目：`E:\projects\iris`
* commit：`805620e09c930fadb0c06140fdf98115995a786f`
* branch：`exploration/embedded-agent`
* 当前开发运行时：Electron 43.4.0 / Node 24.18.1
* 正常打包版运行时：Electron 31.7.7 / Node 20.18.0
* Chokidar：两边均为 5.0.0
* 主日志：`C:\Users\liyue\.iris-dev\logs\main-debug.log`

复现步骤：

1. 启用 `GitManager` 的 worktree watcher。
2. 启动 Iris 开发版。
3. 打开 `E:\projects\iris`。

实际结果：

项目打开后窗口无响应。主进程约有 19,626 个 handles；日志出现 `EPERM: operation not permitted, watch`。

隔离结果：

保持当前支线其他代码不变，仅禁止 Git watcher 启动后，同一项目可以正常打开并保持响应；主进程 handles 降至约 1,389。因此问题已隔离到 Git watcher。

## 根因

`GitManager` 将整个 Git worktree 作为 Chokidar 监听目标。当前 `ignored` 回调只过滤 `.git` 内部不需要关注的元数据，不解析或复用 Git ignore 语义，因此 Git 已忽略的 `node_modules`、`out`、缓存和其他未跟踪目录仍会被递归遍历。

当前项目约有 6,456 个目录，其中 `node_modules` 约 5,244 个，而 Git tracked 文件实际只涉及约 179 个目录。Chokidar 在 Windows 上为递归发现的目录建立目录级 `fs.watch`，导致大量内核 watcher handles 和文件事件压入 Electron main 进程，最终阻塞窗口消息循环和 IPC。

Electron 43 / Node 24 是触发或放大条件，不是单独根因。缺少有界监听范围才是设计缺陷。开发模式持续改写项目内 `out` 文件，也会进一步放大事件压力。

## 当前临时措施

`src/main/git-manager.ts` 当前设置：

```ts
const GIT_WATCHER_ENABLED = false;
```

该开关只用于隔离诊断：

* Git `status`、`stage`、`unstage`、`commit` 和 branch 操作仍可用。
* 外部文件变化不再自动刷新 Source Control。
* `npm run typecheck` 和 `npm run build` 已通过。
* 4 个不依赖 watcher 的 GitManager 集成测试已通过。

## 修复边界

- [x] 设计有界的 Git 变更信号源，不再递归监听整个 worktree。

- [x] 保留 Git dir/common dir 中 `index`、`HEAD`、`packed-refs` 和 `refs` 等权威元数据监听。

- [x] 为 worktree 内容变化选择可控方案，明确刷新延迟、资源上限和多窗口行为。

- [x] 不使用仅硬编码 `node_modules`、`out` 的黑名单作为最终修复；方案必须覆盖任意 Git ignored 大目录。

- [x] linked worktree、submodule、项目位于仓库子目录等既有语义不得退化。

- [x] 正式修复后删除 `GIT_WATCHER_ENABLED = false` 临时开关。

## 验收条件

- [ ] Electron 43 / Windows 下打开包含至少 5,000 个 ignored 子目录的项目，界面保持可交互。

- [ ] 打开项目后主进程 handle 数量保持在明确且稳定的上限内，不随 ignored 目录数量线性增长。

- [x] tracked 文件外部修改能够在约定延迟内触发 Source Control 刷新。

- [ ] ignored 目录内高频写入不会产生刷新风暴或显著增加 main 进程 CPU。

- [ ] 外部 `git add`、commit、branch switch 和 linked worktree index 变化仍可被发现。

- [x] GitManager watcher 专项测试恢复并通过，增加大型 ignored 目录资源回归覆盖。

- [ ] 恢复 Iris Agent 第一轮手工测试，先验证打开项目和空状态入口。

## 关联

* 阻塞来源：[第一轮手工测试流程](./2026-08-13-第一轮手工测试流程.md)
* 相关实现：`src/main/git-manager.ts`

## 方案设计（2026-08-13）

### 结论

采用“有限 Git 元数据监听 + Git 原生状态指纹轮询”的混合模型。不要再把
worktree 根交给 Chokidar，也不要在 Iris 中重新实现 `.gitignore` 解析。

两类信号只负责宣布“状态可能失效”，最终状态仍由现有
`git status --porcelain=v1 -z --branch --untracked-files=all` reconciliation 决定：

1. Git 元数据走低延迟 watcher，覆盖当前 worktree 的 `index`、`HEAD`、
   `index.lock`，以及 common dir 的 `packed-refs`、当前 loose ref 和有限的
   `refs` 目录信号。
2. worktree 内容走固定频率的 Git 状态指纹探测。Git 自己负责 tracked、
   untracked、ignore、nested ignore、`info/exclude`、全局 excludes 和 submodule
   语义；探测输出与上次不同才发出 `changed`。
3. 元数据事件和状态指纹变化继续进入现有 150 ms debounce，Renderer 收到
   `changed` 后执行完整 `status()`，不把文件系统事件当作 Git 状态真相。

该模型牺牲 worktree 文件事件的毫秒级响应，换取确定的资源边界和完整的 Git
语义。建议约定普通外部文件变化在 3 秒内刷新；index、HEAD 和 ref 等元数据变化
通常在 500 ms 内刷新。

### 信号源边界

元数据 watcher 必须满足以下约束：

* 绝不监听 `worktreeRoot`、项目根或任意普通内容目录。
* 只监听显式元数据文件和非递归目录层；已知 loose refs 可以动态加入，但每个
  repository identity 的 watcher target 设置硬上限，建议为 256。超过上限时依赖
  周期性 ref 指纹探测，不扩大 watcher。
* `index.lock` 创建和变化不刷新，仍在删除后刷新，避免读取写入中的 index。
* 元数据 watcher 出错时进入 degraded 状态并退避重建，但 worktree/ref 轮询继续
  工作，因此 watcher 错误不会让自动刷新完全失效。

worktree 探测建议复用与 `status()` 相同的 porcelain 命令形成字节级指纹。每个
repository identity 默认每 2 秒至多启动一次，加入少量 jitter；前一个命令未结束时
跳过本轮，不排队。失败采用现有指数退避，上限 30 秒，成功后恢复正常周期。忽略目录
中的写入不会产生文件事件，探测频率也不会随写入频率改变。

另外以较低频率或同轮附带 `for-each-ref` 指纹，补足非当前分支新增、删除和 packed/
loose ref 转换。项目打开时若尚不是仓库，则只周期性重试 repository discovery；一旦
`rev-parse` 成功，再原子切换到上述信号源。这保留“打开后才 `git init`”的既有行为。

### 多窗口与生命周期

新增 main process 级 `GitWatchCoordinator`，以当前的 repository identity
（`worktreeRoot + gitDir`）为 key，共享探测器、元数据 watcher、最近指纹和退避状态。
每个 `GitManager` 只订阅/退订：

* 同一 worktree 被多个窗口打开时只运行一套 watcher 和轮询。
* linked worktree 因 `gitDir` 和 index 不同，拥有独立 worktree 探测；common dir 的
  ref 变化可以广播给引用它的所有 identity。
* 最后一个订阅者关闭时停止 timer、终止或等待当前 probe、关闭 watcher 并释放缓存。
* 应用级 Git probe 并发建议限制为 2；繁忙仓库只延后下一轮，不允许积压子进程。

probe 只负责比较并发出失效信号，不直接覆盖 `GitManager` 的 revision/stale 快照。
这样可以先保留现有 IPC 与 Renderer 乱序屏障，缩小第一版修复面。后续若性能数据表明
重复 status 成本明显，再单独设计 probe 快照复用，不能在本修复中混入缓存语义变化。

### 不采用的方案

* 不用 `node_modules`、`out` 等目录名黑名单：不能覆盖任意项目和用户 ignore 规则。
* 不在 Chokidar 的同步 `ignored` 回调中调用 `git check-ignore`，也不自行解析
  `.gitignore`：前者无法可靠、低成本地逐路径执行，后者容易遗漏 nested negation、
  `info/exclude`、global excludes、worktree 和 submodule 语义。
* 不只监听 tracked 文件：会漏掉新建 untracked 文件、未跟踪目录和部分原子替换；显式
  文件 target 还会让 handle 数随 tracked 目录数量增长。
* 不自动修改用户仓库的 `core.fsmonitor` 或启动 Git fsmonitor daemon：这会改变仓库配置和
  引入额外进程生命周期。它可以作为未来可选优化，但不能成为正确性的前提。
* 不把纯定时 `status()` 直接推给 Renderer：没有指纹比较会造成固定 UI 刷新和 IPC 压力；
  探测应只在语义输出变化时发出 `changed`。

### 资源与时序契约

第一版实现应把下列数字固化为常量、诊断日志和测试断言，而不是只靠手工感受：

* worktree 递归 watcher 数量为 0。
* 每个 repository identity 的元数据 target 不超过 256；正常小仓库的 Git watcher
  handle 增量目标不超过 64。
* 5,000 个 ignored 子目录相对空 ignored 目录的稳定 handle 差值不超过 10，且持续
  5 分钟不单调增长。
* 每个活跃 identity 的 worktree probe 不超过每分钟 30 次；同一 identity 同时最多
  1 个，全应用同时最多 2 个。
* tracked/untracked/submodule worktree 变化在 3 秒内触发，index/HEAD/ref 变化在
  500 ms 内触发；错误退避期间允许延长并显示 degraded health。
* ignored 目录高频写入不产生 `changed`，不会提高 probe 频率，也不会重建 watcher。

### 实施顺序

- [ ] 抽出可测试的 repository probe 和指纹比较，覆盖 porcelain、refs、超时、无重叠及退避。

- [ ] 引入按 repository identity 引用计数的 `GitWatchCoordinator`，实现订阅、广播、并发上限和完整释放。

- [x] 将 Chokidar target 缩到有限 Git 元数据，增加 target 上限及超限后的 polling fallback。

- [x] 接入 2 秒 worktree probe 和 repository discovery probe，保留现有 debounce、health、revision 与 stale 契约。

- [x] 删除 `GIT_WATCHER_ENABLED = false` 和针对整棵 worktree 的 ignore/filter 代码。

- [ ] 改写 watcher 集成测试：覆盖 tracked、untracked、ignored storm、外部 add/commit/switch、refs、linked worktree、submodule 和项目位于仓库子目录。

- [ ] 增加包含 5,000 个 ignored 子目录的 Windows 资源回归，记录 watcher targets、probe 次数、并发峰值和相对 handle 增量。

- [ ] 手工验证 Electron 43 下项目打开、持续交互、Source Control 延迟和 Iris Agent 空状态入口，再解除对第一轮手工测试的阻塞。

## 实施记录

### 2026-08-13

开始第一轮实现：落地共享协调器、有限 Git 元数据监听和 Git 原生状态指纹探测；本轮不运行构建或开发服务器。

第一轮实现完成：

* `GitWatchCoordinator` 按 `worktreeRoot + gitDir` 共享元数据 watcher、状态指纹、退避和并发配额，最后一个订阅者关闭时完整释放。
* Chokidar target 缩到 `index`、`index.lock`、`HEAD`、`packed-refs` 和当前 symbolic ref，不再包含 worktree 或项目根；HEAD 改变后重建 current-ref target。
* 每个 identity 以 2 秒加 jitter 运行 Git 原生 status/ref 指纹 probe，同一 identity 不重叠，全应用并发上限为 2；失败指数退避到 30 秒，恢复后清除 degraded health。
* 非仓库项目使用 2 秒 repository discovery probe，保留打开后执行 `git init` 的既有行为。
* 删除 `GIT_WATCHER_ENABLED = false` 及原 worktree ignore/filter 路径，外部 tracked/untracked 修改恢复自动刷新。
* GitManager 定向测试共 24 项通过，新增 5,000 个 ignored 子目录、ignored 写入不失效和外部 commit ref 变化覆盖。
* 完整测试共 74 个测试文件、385 项测试全部通过；`npm run typecheck` 通过。

仍需真实 Electron 43 手工测量主进程 handle、CPU 和交互延迟，并验证 ignored 目录持续高频写入、外部 branch switch 及 Iris Agent 第一轮入口。因此 issue 保持 `In Progress`。
