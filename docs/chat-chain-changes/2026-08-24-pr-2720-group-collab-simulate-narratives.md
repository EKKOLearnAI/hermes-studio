---
date: 2026-08-24
pr: 2720
feature: Group Collab simulate mode and chat narratives
impact: 群协作在聊天 transcript 中先播报协调/分派/交接/汇总旁白，再插入看板面板；支持 HERMES_COLLAB_SIMULATE 零 Token 脚本演示，真实模式同样写旁白而不另调 LLM。
---

Touched chain surfaces: group-chat client API/store, CollabTaskBoard / GroupMessageItem / GroupChatPanel / GroupChatInput, group-chat routes, and `collab-orchestrator` / `collab-simulate` under group-chat services.
