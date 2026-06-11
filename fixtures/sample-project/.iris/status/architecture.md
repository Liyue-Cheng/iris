---
title: 服务架构现状
status: in_progress
reflects: a1b3c2d
---
# 服务架构现状

当前系统由三个服务组成：

* **api-gateway** — 对外 HTTP 入口，做路由与鉴权

* **core-service** — 业务核心，读写主库

* **worker** — 异步任务（邮件、报表）

## 已知边界

| 服务           | 通信方式      | 你是猪 | 数据所有权         |
| ------------ | --------- | :-- | ------------- |
| api-gateway  | HTTP      | 你是猪 | 无             |
| core-service | HTTP + MQ | 你是猪 | users, orders |
| worker       | MQ        | 你是猪 | jobs          |

鉴权目前在 gateway 层用中间件实现，详见 `src/auth/`。   
