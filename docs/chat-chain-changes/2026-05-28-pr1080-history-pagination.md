---
date: 2026-05-28
pr: 1080
commit: a6b3bec2
feature: 历史消息分页和虚拟列表
impact: 刷新、切换、多 tab resume 时不再一次性加载全部历史消息。
---

前端 session 状态新增 `messageTotal`、`loadedMessageCount`、`hasMoreBefore` 等字段；HTTP session API 新增分页消息读取；`resume` payload 携带分页元数据。
