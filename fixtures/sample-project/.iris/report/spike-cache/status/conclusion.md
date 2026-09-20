---
title: 缓存探索结论
status: done
reflects: 9c8b7a6
---

# 缓存探索结论

网关层加 LRU 对命中率提升不到 3%，不值得引入失效复杂度。**不做。**

本文属于位于 `report/` 下的普通工作区 spike-cache，按 status 文档正常展示。
