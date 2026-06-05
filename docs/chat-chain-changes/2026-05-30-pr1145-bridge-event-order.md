---
date: 2026-05-30
pr: 1145
commit: cb410e50
feature: Bridge 文本和工具事件顺序
impact: 避免“文本 -> tool -> 文本”场景把字拆开或重复输出。
---

Bridge 将每个文本 chunk 同步写入 `events` 中的 `stream.delta`，Node 端在事件循环内按顺序处理 `stream.delta`，并在同一 chunk 已有 ordered delta 时跳过聚合 `chunk.delta`。
