---
date: 2026-08-22
pr: 2662
feature: Stable Coding Agent reasoning and grouped tool runs
impact: Single-chat runs keep live reasoning and running tools in fixed-height rows, persist run markers for completed tool grouping, and preserve provider reasoning state across tool continuations.
---

Single-chat tool traces now keep only running tools in the fixed-height live
strip. Completed calls move into the transcript immediately and calls that
share a run marker are grouped into an animated, collapsible card. Calls
without a run marker remain individual transcript rows. Persisting the marker
on each message keeps the grouping stable after session reloads and branches.
Bridge/Hermes, Ekko Agent, and Responses-based Coding Agents now use one shared
run-message persistence path, so the database row and live in-memory message
receive the same run marker, tool status, reasoning, and display metadata.
Group-chat room messages keep their separate persistence and presentation
pipeline; only their temporary Agent child execution passes through this
shared normalizer before that child session is disposed.

Live reasoning uses one reserved line that follows streaming text without
inserting an ellipsis. The running-tool strip also stays on one reserved line,
so reasoning and tool updates do not repeatedly change the transcript height.
Completed individual tools expose explicit success and failure states.

Global Codex, Claude, and Pi sessions keep their CLI-owned model selection and
therefore do not expose Studio model switching. Profile-scoped Coding Agent
sessions retain their existing model controls.

When a Responses client continues a DeepSeek-style Chat Completions tool call,
the proxy now associates the preceding reasoning item with the assistant tool
call and replays it as `reasoning_content` before the tool result. Providers
that do not use this protocol receive their existing message shape.
