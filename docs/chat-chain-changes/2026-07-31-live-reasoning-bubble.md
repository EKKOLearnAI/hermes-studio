---
date: 2026-07-31
pr: pending
feature: Keep live single-chat reasoning inside its message bubble
impact: Reasoning-only streaming assistant output now follows the same MessageItem rendering path as resumed conversation history. Each tool boundary starts a fresh assistant reasoning segment instead of accumulating later thinking in the first bubble. Completion output without a body delta is attached to the active reasoning bubble; sealed reasoning-only tool-call replies remain in state but no longer leave a standalone bubble. Their persisted reasoning is associated with the matching tool call and appears as the first of three expanded detail sections: reasoning, arguments, and result, in both direct and group chat. The thinking animation and surrounding run toolbar remain visible for the full run lifecycle, including tool execution, and close only when the run or abort lifecycle ends.
---
