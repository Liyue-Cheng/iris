---
title: 旧 token 的过期语义不一致
status: todo
---

# 旧 token 的过期语义不一致

legacy token 的 `exp` 是秒，opaque token 的过期靠查库。策略表的 `Claims`
需要统一过期表达，否则中间件还得留特判。

本 issue 属于 spike-auth 子工作区——它出现在子工作区的 issue 透镜下，
不应混进根工作区。
