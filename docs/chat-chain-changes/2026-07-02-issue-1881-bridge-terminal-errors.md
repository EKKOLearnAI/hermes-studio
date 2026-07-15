---
date: 2026-07-02
pr: 1890
feature: Bridge terminal error detection
impact: Completed bridge runs no longer fail just because successful assistant text mentions HTTP status handling or a generic result message.
---

Issue #1881 showed successful assistant output being rendered as a failed run
when the response text mentioned HTTP status handling such as 401 redirects.
Terminal error detection now keeps explicit bridge or agent failure flags as
authoritative and only uses text matching for compact provider/API error shapes.
