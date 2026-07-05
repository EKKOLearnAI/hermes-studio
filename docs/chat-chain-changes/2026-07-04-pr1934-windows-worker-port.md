---
date: 2026-07-04
pr: 1934
commit: 90c4edd
feature: Windows Agent Bridge 工作进程端口选择
impact: 当桌面运行时提供 Windows 动态/私有端口段内的 worker port base 时，Agent Bridge 回退到默认安全端口段，避免命中系统保留端口导致 profile worker 启动失败；不改变 chat-run 协议、消息落库或工具审批行为。
---

`bridge_transport.py` 在 Windows TCP worker 端点计算中会识别 `HERMES_AGENT_BRIDGE_WORKER_PORT_BASE` 是否落入 49152-65535 动态/私有端口段；若落入该范围，则改用默认的 18780 基准端口，避免哈希偏移后选中被系统排除的端口并触发 `WinError 10013`。
