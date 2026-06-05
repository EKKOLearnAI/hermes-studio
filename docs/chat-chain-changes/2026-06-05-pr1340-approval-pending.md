---
date: 2026-06-05
pr: 1340
feature: Approval / clarify pending state
impact: `/chat-run` approval/clarify replay state 在 bridge resolve 后清理、bridge reject 时恢复；前端 resume 缺失 pending request 时清理 stale badge/card。Chat UI 恢复 session list approval/needs-answer badge，并把 approval/clarify pending card 改为输入区上方的堆叠提示，避免同 session 双 pending 或多行输入时遮挡。
---

普通 Chat 的 approval / clarify pending 链路补齐后，待处理状态不再只依赖一次性 live event：刷新、重连、完成、失败和 bridge response 失败都会维护同一份 replay/pending 状态，前端 session badge 与输入区上方 pending card 同步更新。
