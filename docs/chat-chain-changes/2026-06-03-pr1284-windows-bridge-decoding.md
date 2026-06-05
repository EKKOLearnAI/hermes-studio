---
date: 2026-06-03
pr: 1284
commit: 2aeed108
feature: Windows Agent Bridge 子进程输出解码
impact: 修复本地 code page 输出导致 subprocess reader 线程抛 `UnicodeDecodeError` 的问题，不改变 `/chat-run` 协议、消息落库或工具审批行为。
---

`hermes_bridge.py` 的 Windows parent PID 探测和 stale bridge 进程清理改用平台文本编码读取 `tasklist.exe` / `taskkill.exe` 输出，并忽略不可解码字节。
