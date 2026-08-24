---
date: 2026-08-24
pr: 2721
feature: Workspace diff message-window sidecars
impact: Single-chat resume and history pages now carry only the workspace diff summaries attributed to assistant messages in the loaded window.
---

# Workspace diff message-window sidecars

## Touched feature

- Single-chat resume payloads and paginated history responses.
- Studio Web and App workspace-diff restoration.
- App conditional resume cache identity and contents.

## Behavior impact

Workspace diff summaries now follow the loaded message window instead of being
fetched for the entire session. The server batches diff lookup by the assistant
message ids present in each resume or history page. Studio replaces or merges
those page sidecars as messages are refreshed or paged backward, while live
`workspace.diff.completed` events continue to upsert individual changes.

The App stores the current page's diff sidecar with its cached messages. Diff
summaries participate in the conditional resume hash, so a diff created after
its assistant message invalidates the old cache even when message content did
not change. File patches remain lazy-loaded through the existing per-file API.

The legacy session-wide workspace-run-changes endpoint remains available for
compatibility and diagnostics, but the main Studio and App single-chat paths no
longer call it.
