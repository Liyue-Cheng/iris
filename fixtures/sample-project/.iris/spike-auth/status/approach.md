---
title: 策略表方案现状
status: in_progress
reflects: e4f5a6b
---

# 策略表方案现状

接口已定型：

```ts
interface TokenParser {
  scheme: string
  parse(raw: string): Claims | null
}
```

注册表用 Map，gateway 中间件只查表分发。三种现有格式中已迁移一种（JWT）。
