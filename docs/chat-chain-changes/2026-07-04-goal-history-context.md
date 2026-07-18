---
date: 2026-07-04
pr: 1946
feature: Goal kickoff history context fix
impact: /goal commands now preserve the full conversation history so the agent can reference prior context instead of starting with an empty history.
---

Three files in the run-chat pipeline were updated:

- **`session-command.ts`**: Goal QueuedRun sets `source: 'goal_kickoff'` to
  distinguish goal kickoff runs from normal CLI runs.
- **`handle-bridge-run.ts`**: Detects `goal_kickoff` source and passes
  `excludeLastUser: false` when building history for compression, so the goal
  does not truncate the previous round's conversation.
- **`compression.ts`**: `buildCompressedHistory` accepts an optional
  `{ excludeLastUser }` parameter (default `true` for backward compatibility).
