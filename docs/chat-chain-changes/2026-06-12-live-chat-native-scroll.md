---
date: 2026-06-12
pr: pending
feature: Live and group chat transcript scrolling
impact: Live and group chat transcripts use native scrolling instead of dynamic virtualization to reduce environment-dependent jumps during streaming responses.
---

`MessageList` and `GroupMessageList` now disable `VirtualMessageList` virtualization for active live transcripts. `VirtualMessageList` keeps the same exposed scroll API and still defaults to virtualized rendering for history and other callers, but can render a native scroll container when `virtualized` is false.
