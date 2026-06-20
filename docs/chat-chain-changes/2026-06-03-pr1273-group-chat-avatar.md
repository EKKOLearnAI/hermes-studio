---
date: 2026-06-03
pr: 1273
commit: 91bb68dc
feature: 用户头像上传；group-chat 成员头像同步
impact: 不改变普通 Chat run，但改变 group-chat 成员元数据和消息展示。
---

auth 用户头像进入 group-chat 成员展示链路，`/group-chat` handshake 携带 `authUserId`，服务端按用户 id/name 查头像并同步给 room members。
