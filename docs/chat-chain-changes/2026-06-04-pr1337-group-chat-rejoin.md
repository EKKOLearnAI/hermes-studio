---
date: 2026-06-04
pr: 1337
feature: Group Chat socket reconnect/rejoin
impact: `/group-chat` 前端 store 在 socket reconnect 后会重新 join 当前 room，并合并 join ack 中返回的消息以补回断线期间错过的内容。
---

Reconnect 后同时恢复 members/agents/typing/context status。若用户在 ack 返回前切换房间，会忽略旧 room ack；join ack 中的 `rooms` 字符串列表不会覆盖前端 `RoomInfo[]` 房间列表，避免路由和侧边栏状态被污染。
