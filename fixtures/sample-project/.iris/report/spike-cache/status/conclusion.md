---
title: 缓存探索结论
status: done
reflects: 9c8b7a6
---

# 缓存探索结论

网关层加 LRU 对命中率提升不到 3%，不值得引入失效复杂度。**不做。**

本文属于归档工作区 spike-cache：它应随整个工作区灰化，但仍可打开阅读。
