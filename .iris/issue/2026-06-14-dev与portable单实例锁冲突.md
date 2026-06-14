---
title: dev 与 portable 共享 userData 导致单实例锁互斥
status: Done
labels: [round-4, bug]
---
用户报告：portable 已在运行时再 `npm run dev`，开发实例直接退出，日志打印 `[main] another instance holds the lock — quitting`，无法同时开 portable 与开发服务器。

## 根因

`app.requestSingleInstanceLock()`（`src/main/index.ts`，原为修 portable GPU-cache 引入）的锁按 **userData 目录全局唯一**，不区分 dev / portable，只认"该 profile 上是否已有 Iris 进程"。

dev 与 portable 解析到同一个 userData —— `%APPDATA%\iris-app`（取自 `package.json` 的 `name: "iris-app"`，磁盘上确认是唯一的 iris 目录）。于是两者被当成"同一 Iris 的第二实例"：先启动者抢锁，后启动者走进 `if` → `app.quit()`。这是该段代码按设计工作的副作用，非 bug。

补充：Iris 业务设置在 `~/.iris/settings.json`（homedir 派生），**不在 userData**，所以共享 userData 只影响 Chromium profile/缓存与这把锁。

## 修复（已落）

`src/main/index.ts`：在 `requestSingleInstanceLock` 之前，仅 dev 下给一个独立 userData：

```ts
if (isDev) {
  app.setPath('userData', `${app.getPath('userData')}-dev`);
}
```

dev 改用 `%APPDATA%\iris-app-dev`，与 portable 的 `iris-app` 互不相干——独立的 profile、独立的锁、独立的 Chromium 缓存，两者可真正并行运行。仅 dev 生效，安装版/portable 行为不变。

取舍：另一方案是 dev 直接跳过锁（`if (!isDev && !requestSingleInstanceLock())`），改动更小，但 dev 与 portable 仍共享缓存目录，理论上还可能在缓存锁上互相打架。选独立 userData 是为彻底隔离。

## 验收

- `npm run typecheck` 通过。
- ✋ 手工：先开 portable，再 `npm run dev`，两者应都能正常起窗、互不退出；首次 dev 启动会在 `%APPDATA%` 下新建 `iris-app-dev`。
