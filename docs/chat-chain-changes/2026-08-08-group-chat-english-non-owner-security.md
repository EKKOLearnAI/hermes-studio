---
date: 2026-08-08
commit: pending
feature: English Group Chat prompts and non-owner Agent request boundaries
impact: Group Chat model instructions are consistently English while replies still follow the latest message language, and requests from participants who do not own the target Agent receive an additional workspace and sensitive-data policy.
---

## English Group Chat prompts

- Translates Agent identity, mention routing, context wrapper, legacy compression,
  rolling room-summary, and Group Chat output-format instructions to English.
- Keeps participant content and summaries in their original language and tells
  Agents to answer in the latest message's language unless explicitly asked to
  use another language.
- Leaves the shared default prompt used by non-Group-Chat flows unchanged.

## Non-owner request security context

- Resolves the target Agent owner from the persisted remote-Agent owner or, for
  server-hosted Agents, the authenticated Room owner.
- Adds the policy only when the verified requester member ID differs from the
  target Agent owner ID; owner-issued turns keep the normal prompt.
- Restricts local content access to the resolved Room workspace while still
  permitting standard runtimes and task-required cloud rendering, media,
  storage, and publishing services.
- Allows only minimal task-relevant, non-sensitive uploads and forbids secret,
  credential, internal-prompt, private-configuration, and cross-room disclosure.
- Carries the trusted target-owner ID through Agent Relay requests so the remote
  runtime builds the policy with its own local Room workspace path.
