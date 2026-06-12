---
title: 鉴权中间件重构
status: in_progress
labels: [auth, refactor]
---

# 鉴权中间件重构

gateway 的鉴权中间件耦合了三种 token 格式的解析，每加一种格式都要改核心分支。

## 目标

- 把 token 解析拆成策略表
- 新格式 = 注册一个解析器，不动中间件本体

## 进展

- [x] 现状梳理
- [ ] 策略表接口设计
- [ ] 迁移现有三种格式
