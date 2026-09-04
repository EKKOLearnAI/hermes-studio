---
date: 2026-08-09
pr: 2454
feature: busy-input-mode-main-chat
impact: The main chat now has a working Queue / Interrupt / Steer selector for sending messages while a run is live; interrupt stops the current run (abort + wait for abort.completed) before sending, and steer rewrites the message to /steer so it is injected into the current bridge run instead of queued.
---

# Busy input mode for the main chat

`busy_input_mode` existed only in API types and i18n strings; the input box was never locked, but messages sent while the AI was processing were silently queued behind the whole current run, with no way to interrupt or steer from the main chat (group chat already had `interruptAgent`).

The `sendMessage` path in the chat store now honours the setting:

- `steer` — while a bridge run is live, the message is rewritten to `/steer <text>` so it is injected into the current run (skipped for coding-agent sessions, which have no bridge steer method, and for explicit slash commands).
- `interrupt` — before sending, emits `abort` and waits for `abort.completed` (synced) up to 20s, so the new message is processed immediately instead of being queued.
- `queue` (default) — existing behaviour unchanged.

Display settings gained a dropdown (Queue / Interrupt / Steer) with en/zh labels. Client-side only: the server already handled `abort` and `/steer`.
