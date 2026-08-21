---
date: 2026-08-21
pr: 2656
feature: Resume Pi coding-agent sessions
impact: Direct Pi chats now reopen their persisted native session after each RPC process restart, while group-chat turns remain temporary and receive room history explicitly.
---

Studio now passes the generated or stored Pi native session UUID into the actual RPC launch. Pi's exact `--session-id` behavior creates the session on the first turn and opens the existing session file on later turns.

Group-chat coding agents intentionally use a fresh temporary runtime session for every mention and delete its Studio session afterward. Their prompt includes the current room summary and post-summary history, so this change does not add native resume to group chat and does not duplicate previously injected room context.
