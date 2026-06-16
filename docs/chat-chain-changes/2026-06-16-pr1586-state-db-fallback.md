---
date: 2026-06-16
pr: 1586
feature: loadSessionStateFromDb 增加 state.db 回退
impact: Socket.IO resume 路径在本地 DB 无消息时回退到 hermes-agent state.db 查询
---

`loadSessionStateFromDb()` 原本只通过 `getSessionDetailPaginated()` 查询 web-ui 本地 DB，当本地 DB 无会话消息时返回空。HTTP API 路径（`getConversationMessagesPaginated` controller）已有 `getSessionDetailPaginatedFromDbWithProfile()` 回退，但 resume 路径缺失。修复后当本地 DB 无消息时回退到 state.db 查询，使旧版会话（消息仅存于 state.db）恢复正常加载。
