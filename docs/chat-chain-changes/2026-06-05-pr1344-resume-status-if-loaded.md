---
date: 2026-06-05
pr: 1344
feature: Chat resume bridge status 探测
impact: 进入或切换会话不会因为 resume 探测而冷启动 profile worker。
---

`ChatRunSocket.resume` 改用 broker 的 `status_if_loaded` 查询，只在对应 profile worker 已存在时转发为 worker `status`。若 worker 已加载且原 run 仍在运行，仍会通过 `resumeBridgeRun()` 继续接回 `run_id` 的 delta/events；不存在的 session status 不会污染 broker session route。
