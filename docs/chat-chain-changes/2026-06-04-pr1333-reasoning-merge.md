---
date: 2026-06-04
pr: 1333
feature: reasoning 多轮合并为单条 assistant 消息
impact: 同一 run 内跨 tool cycle 的 thinking 会收敛到同一条 assistant 气泡。
---

`chat.ts` 用独立的 reasoning 目标合并 `reasoning.delta` / `thinking.delta`；`tool.started` 仍会切断正文流目标，后续 `message.delta` 会在 tool 后新建 assistant，避免最终正文插回工具前。
