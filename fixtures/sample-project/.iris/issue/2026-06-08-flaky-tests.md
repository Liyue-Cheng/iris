---
title: worker 集成测试偶发超时
status: todo
---

# worker 集成测试偶发超时

`worker/jobs.test.ts` 在 CI 上约 1/10 概率超时，本地不复现。

怀疑与 MQ 容器的启动时序有关。需要先收集失败日志再定位。
