---
date: 2026-08-22
pr: 2681
feature: Exact Gateway approval waiter settlement
impact: Interrupting a Group Agent run now denies its exact Hermes Gateway waiter by Runtime request ID without consuming another generation's waiter from the same Session.
---

Gateway approval notifications retain the Runtime `request_id` beside their exact Session and run generation. Interrupt and user-response paths pass that identity back to Hermes Agent, while missing request IDs fail closed instead of falling back to Session FIFO.
