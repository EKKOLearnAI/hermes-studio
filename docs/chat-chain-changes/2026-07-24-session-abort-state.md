---
date: 2026-07-24
pr: 2203
feature: Session-scoped chat abort state
impact: Pausing one conversation no longer shows a pause state or disables stop controls in another conversation.
---

Client abort lifecycle state is now keyed by session ID, matching the existing
session-scoped socket routing and compression state. Background abort, timeout,
completion, and resumed-run events update only their owning conversation.

The server abort protocol and persisted chat history are unchanged.
