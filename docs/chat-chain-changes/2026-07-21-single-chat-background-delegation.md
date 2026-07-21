---
date: 2026-07-21
pr: 2160
feature: Single-chat background delegation and authoritative terminal output
impact: Ordinary Hermes chats can deliver background tasks after the parent turn, while terminal responses retain authoritative interim assistant text.
---

Ordinary single-chat Hermes Agent sessions now enable background delegation at
creation. Group-chat agents and Hermes workflow-node agents continue to pass an
explicit disabled policy, so their behavior is unchanged.

Completed runs now prefer the server's reconciled output over the Bridge's raw
delta snapshot. This preserves interim callback corrections and callback-only
assistant commentary in the terminal response consumed by HTTP and relay
callers.
