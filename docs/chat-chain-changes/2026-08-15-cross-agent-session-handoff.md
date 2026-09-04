---
date: 2026-08-15
pr: 2559
feature: Cross-agent session handoff
impact: Codex / Claude Code sessions can now be continued in a new Hermes session from the session context menu.
---

Adds the first phase of cross-agent session handoff: a user can pick a Codex or
Claude Code session and create a new Hermes session that carries the source
conversation context, workspace, and parent lineage.

Server changes:

- `packages/server/src/db/hermes/session-store.ts` adds `createHandoffSession()`
  without marking the source session as branched or ended.
- `packages/server/src/services/hermes/session-handoff.ts` normalizes Codex /
  Claude Code history to user/assistant messages and creates the Hermes session.
- `packages/server/src/controllers/hermes/sessions.ts` and
  `packages/server/src/routes/hermes/sessions.ts` expose
  `POST /api/hermes/sessions/:id/handoff`.

Client changes:

- `packages/client/src/api/hermes/sessions.ts` adds `handoffSessionToHermes()`.
- `ChatPanel.vue` and `HistoryView.vue` add a "Continue in Hermes" context-menu
  action for Codex / Claude Code sessions.
- `packages/client/src/stores/hermes/chat.ts` adds `openHandoffSession()` to
  switch to the newly created Hermes session.

The source session is never mutated. Tool and command rows are not copied into
the Hermes context in this phase; only user and assistant text is carried over.
