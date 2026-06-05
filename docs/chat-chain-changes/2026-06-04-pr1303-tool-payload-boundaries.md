---
date: 2026-06-04
pr: 1303
feature: Chat / Group Chat 工具详情与完成事件边界
impact: 空 `run.completed.parsed_content` 不会把旧 assistant 消息误当成本次输出。
---

前端 message item 和 store mapping 现在保留 object / array / number / boolean 工具 payload，`0` / `false` 不再因为 falsy 判断被隐藏；普通文本结果继续按 TEXT 展示。空 `run.completed.parsed_content` 只会保留当前流式 assistant 内容。
