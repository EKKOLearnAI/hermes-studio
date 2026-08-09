---
date: 2026-08-09
pr: pending
feature: Non-blocking Chat Run webhooks
impact: Bridge, Ekko, Claude Code, and Codex runs can publish stable Chat Run lifecycle events to multiple configured Webhook endpoints without waiting for network delivery.
---

Super administrators can manage multiple Webhook endpoints under Settings →
Webhooks. Each endpoint can filter message, queue, run, tool, approval, and
clarification lifecycle events by profile, opt in separately to user and final
assistant text, configure retries, and use an HMAC-SHA256 signing secret. Tool
arguments and results, reasoning, and system prompts are not included.
Existing endpoint subscriptions are preserved during upgrade; administrators
must explicitly select newly added lifecycle event types. New endpoints offer
the complete stable lifecycle set by default.

Chat execution only appends an event to a bounded in-memory queue. Endpoint
fanout and HTTP delivery happen asynchronously with global parallelism and
per-endpoint ordering, so a slow or unavailable receiver does not block the
Chat Run path or add SQLite writes for individual runs. Pending work is
intentionally discarded when the server restarts; endpoint configuration is
the only Webhook state persisted in SQLite.

The settings page can prefill a disabled endpoint that targets the server's
tokenized loopback-only test receiver. Its row-level Test action exercises the
same payload, headers, URL checks, signing, and timeout path as a real delivery,
so a standalone Studio installation can verify Webhooks without another
service. The settings page also shows the receiver's 50 most recent events,
including their payloads, and can clear them. This test inbox is memory-only and
is emptied on server restart.

Private, loopback, link-local, and reserved targets are rejected by default.
Administrators must explicitly allow private-network delivery, and production
requests connect to the DNS address that was validated immediately before the
request.
