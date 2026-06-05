---
date: 2026-06-05
pr: 1339
commit: 9c1bbbf
feature: Web UI origin policy 和安全响应头
impact: 只影响浏览器 origin 握手边界和响应头，不改变 run 协议、消息落库、resume、approval、queue 或 group-chat agent 执行逻辑。
---

`/chat-run` 与 `/group-chat` 共用的 Socket.IO server 改用统一 origin allowlist；默认只允许同 host 浏览器来源，显式 `CORS_ORIGINS=*` 才保留 wildcard。
