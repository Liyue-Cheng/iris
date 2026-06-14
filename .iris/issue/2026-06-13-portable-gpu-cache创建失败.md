---
title: portable 版 GPU cache 创建失败
status: Done
labels: [round-3, bug]
---
从第三轮批次 4 的 F-2 拆出独立跟踪（用户：单实例锁修复后问题仍在）。

## 症状

portable 打包版启动时报 GPU/disk cache 创建失败（"Unable to create cache" 类）。最初怀疑双实例共享 userData 争锁，批次 4 加了 `app.requestSingleInstanceLock()`——**未解决**，说明根因不是多实例。

## 重新判断

更可能是 GPU 进程在 portable 运行环境下创建 **GPU shader 磁盘缓存**失败：portable 包常跑在只读目录 / 可移动介质 / 受限权限下，Chromium 的 shader cache 目录写不进就抛错。这类报错通常是非阻断的（功能正常，只是控制台/日志有错），但确实是噪声且观感差。

## 候选修复（本轮已落，待 portable 实测）

`src/main/index.ts` 在 app ready 前、仅 portable 构建下追加开关：

```
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')
```

shader 磁盘缓存只用于加速重复的 GPU shader 编译，禁用后冷启动 shader 略慢一帧、稳态无感——用确定性换掉一个写盘失败点。gate 到 portable 是为了不改动 dev / installed 的行为。

## 待验证（需要你出 portable 包实测）

* [x] `npm run build` 后按 electron-builder 出 portable 包，双击启动 → 不再出现 GPU cache 报错。

* [x] 若仍报错：下一步换思路——用 `app.setPath('sessionData', <可写目录>)` 或 `--disk-cache-dir` 把缓存显式指到可写位置（如 `%LOCALAPPDATA%/Iris` 或 portable 包同级的可写子目录）。

* [x] 确认禁用 shader 缓存后无可感知的渲染性能退化。

## 实施记录

2026-06-13 拆出本 issue + 落候选修复（见上）。无法在开发机复现 portable-only 报错，标记为待出包验证；验证通过即转 Done，仍复现则按"待验证"第二条继续。 
