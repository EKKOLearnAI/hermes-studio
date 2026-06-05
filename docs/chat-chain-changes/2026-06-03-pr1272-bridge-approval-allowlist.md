---
date: 2026-06-03
pr: 1272
commit: 2f1686da
feature: Bridge 工具审批 allowlist；Bridge 文本/turn boundary 回调
impact: 保证“始终允许”写入配置后后续同 profile run 能读到，并避免文本 delta 重复。
---

`hermes_bridge.py` 在 agent 创建和每次 run 开始时刷新 `tools.approval` 的 `command_allowlist` 进程内缓存。`stream_delta_callback` 现在只转发 turn boundary，不再把 agent 的文本 delta 再追加一遍，避免和 `stream_callback` 重复。
