---
date: 2026-06-04
commit: local
feature: Hermes 原生 AI session title 回传
impact: 不阻塞最终回复、usage、goal continuation 或队列执行，也不改 run 生命周期。
---

`hermes_bridge.py` 在 bridge run 完成后后台调用 Hermes 原生 `maybe_auto_title()` 写入 Hermes `state.db`，并提示标题语言跟随用户首条消息；Node 在 `run.completed` 后后台按 `session_id` 短轮询 `get_session_title`，同步 Web UI 本地 `sessions.title` 并推给前端。只在本地标题仍为空或等于首条消息/preview fallback 时应用，用户手动改过的标题不会被覆盖。
