# Hermes Web UI Chat / Live Monitor Direction Plan

> For Hermes: use subagent-driven-development only after Han explicitly approves execution.

Goal: clarify whether Chat and Live should both exist, and record the current product recommendation while shipping the bundled live-badge PR.

Architecture: keep the interactive chat write path and any read-only monitor path conceptually separate. In the current product, the immediate user need is best served by direct Live badges in the Chat session list. A separate Live surface is justified only if it becomes a real monitor with distinct observability and triage value.

Tech stack: Vue 3, Pinia, Naive UI, Koa, Hermes session DB.

---

## Current findings

1. Original reason for Live
- Live was introduced as a read-only monitoring surface inside the Chat page.
- The intent was to avoid a separate route/page while still allowing users to inspect conversations without sending messages there.

2. Current product problem
- In practice, Live is too close to a second session browser.
- Chat already contains the main session list and now supports direct Live badges on active rows.
- Without stronger monitor-specific affordances, the Chat/Live toggle weakens the information architecture.

3. External dashboard pattern check
- Useful live monitors are observability surfaces, not duplicate navigators.
- Common differentiators:
  - search
  - source/status filters
  - active vs recent grouping
  - read-only drilldown across many runs
  - monitoring metadata such as live state, last active, errors, counts, source/model, stuck state

4. Decision
- Keep direct Live badges in Chat session rows.
- Do not keep the current Chat/Live toggle long-term unless we rebuild it as a real monitor surface.
- Preferred direction right now: remove the current Live toggle after the bundled PR lands, unless Han wants an explicit monitor rebuild.

---

## Recommended roadmap

### Phase 0: ship the bundled Live badge PR

Objective: land the immediate UX improvement and backend fix already implemented on `feat/chat-session-live-badge`.

Scope:
- direct `Live` badge in normal Chat session rows
- stronger but on-brand badge styling
- DB-backed fix for the current Live monitor backend so the existing surface stops failing on large histories
- tests for both client and server changes

Done when:
- PR is open against `upstream/main`
- branch includes the implementation commits plus this plan doc
- targeted tests and build pass

### Phase 1: product simplification decision

Objective: decide whether to keep or remove the current Chat/Live toggle.

Recommended default:
- remove the current `Chat / Live` toggle
- keep only Chat + row-level Live badges

Why:
- this solves the real user need: show active chats directly where users already work
- it avoids maintaining a half-monitor that duplicates Chat semantics

Done when:
- product decision is explicit: `remove-live-toggle` or `rebuild-monitor`

### Phase 2A: if simplifying, remove the current Live surface

Objective: cleanly remove the current in-Chat Live mode.

Files likely involved:
- `packages/client/src/components/hermes/chat/ChatPanel.vue`
- `packages/client/src/components/hermes/chat/ConversationMonitorPane.vue`
- `packages/client/src/components/hermes/settings/SessionSettings.vue`
- `packages/client/src/stores/hermes/session-browser-prefs.ts`
- related i18n keys and tests

Expected effect:
- Chat remains the only session interaction surface
- active work is indicated directly by row-level `Live` badges
- no duplicate list/detail workflow inside Chat

### Phase 2B: if keeping a monitor, rebuild it as a true monitor

Objective: keep a separate read-only surface only if it becomes clearly distinct from Chat.

Required monitor traits:
- read-only only
- search
- source/type/status filters
- active vs recent grouping
- conversation-chain aggregation rather than raw session browsing
- metadata useful for triage: last active, live/running, visible message count, linked session count, source/model, errors/stuck state

Preferred naming:
- `Monitor` or `Conversations`, not `Live`

Preferred surface:
- a dedicated page/route rather than a peer toggle inside Chat

---

## Review inputs

Independent review summary:
- Branch implementation for the bundled PR is PR-ready; no blocker/major findings.
- Product review recommendation: remove the current Live toggle now unless we commit to rebuilding it as a distinct monitor surface.

---

## Validation commands

Run from repo root:

`npm test -- tests/server/conversations-db.test.ts tests/server/sessions-controller.test.ts tests/client/chat-store.test.ts tests/client/chat-panel.test.ts`

`npm run build`

---

## Artifact note

Canonical plan path:
- `docs/plans/2026-04-22-chat-live-monitor-direction.md`

This file is the source of truth for the current Chat-vs-Live recommendation tied to the bundled live-badge PR.
