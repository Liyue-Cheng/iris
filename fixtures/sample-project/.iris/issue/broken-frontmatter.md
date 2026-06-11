---
title: [这是一段故意损坏的 YAML
status: in_progress
  bad indent: {{
---

# 损坏 frontmatter 的文档

本文件的 frontmatter 是故意写坏的 YAML。

扫描器必须不崩溃，把它降级为"无元数据文档"（按文件名显示、
不参与 issue 活动过滤的隐藏逻辑——宁可多显示也不要静默吞掉）。
