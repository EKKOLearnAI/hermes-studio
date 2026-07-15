---
date: 2026-06-18
pr: pending
feature: Group Chat context and mention-routing hardening
impact: Group Chat now keeps UI pagination separate from agent context history, uses message-id cursors for same-timestamp replies and snapshot rebuilds, clears in-flight agent runs safely, and hardens agent-to-agent mention routing so only explicit leading addresses fan out by default.
---

This change bundle covers the full WUI group-chat context/routing hardening work rather than only the cursor fix: stable canonical ordering for assistant/tool multipart runs, full-retained-history context windows and token estimates, safe clear-context generation resets, snapshot-tail fallback behavior, and the new agent-authored leading-address routing default with a lightweight env rollback gate (`HERMES_GROUP_CHAT_AGENT_LEADING_ADDRESS_ROUTING=0`) if operators need to temporarily revert agent mention parsing behavior during rollout.
