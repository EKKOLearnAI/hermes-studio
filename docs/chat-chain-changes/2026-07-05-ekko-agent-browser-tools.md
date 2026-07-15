---
date: 2026-07-05
pr: pending
feature: Ekko Agent browser tools
impact: Ekko-agent chat runs now pass a stable browser session id into tool context so browser tools share page state during a conversation.
---

`handle-ekko-agent-run` now passes the chat session id into the ekko-agent tool
context as `sessionId` and `browserSessionId`. Browser tool calls use that value
for their `agent-browser` session, so navigation, snapshots, clicks, typing,
screenshots, console reads, and image extraction share browser state during a
conversation.
