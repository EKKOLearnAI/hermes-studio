---
date: 2026-06-26
pr: pending
feature: omp (oh-my-pi) chat agent source
impact: A new chat backend `source: 'omp'` runs the `omp --mode rpc` coding agent as a per-session child process, streaming its events onto the existing /chat-run events and SQLite persistence alongside the Hermes bridge and Claude/Codex coding agents.
---

The omp path stays separate from the Hermes Agent Bridge and the `coding_agent`
runner. `ChatRunSocket.handleRun()` routes `source === 'omp'` to `handleOmpRun`
before the bridge readiness check, so omp runs never touch the Python bridge.

- `omp-session-manager.ts` owns one `omp --mode rpc` child per chat session
  (lazily spawned, reused across runs so omp keeps its in-process context),
  reads newline-delimited JSON frames, writes JSON-line commands, auto-cancels
  interactive `extension_ui_request`s so a headless run never stalls, and recycles
  idle sessions after 30 minutes / on shutdown.
- `handle-omp-run.ts` maps omp `AgentSessionEvent`s onto the same emit + DB
  contract as `handleBridgeRun`: `run.started`, `message.delta`, `reasoning.delta`,
  `tool.started`/`tool.completed`, `usage.updated`, and `run.completed`/`run.failed`.
  It reuses the bridge message/tool persistence helpers (assistant text, tool-call
  and tool-result rows) and `calcAndUpdateUsage`. omp owns its own system prompt,
  tools, and model config, so this path does not inject Hermes instructions or
  build compressed history.
- Abort reuses the `AbortController` path: `handleAbort` flushes omp pending
  content (omp uses the bridge pending fields) and `markAbortCompleted` finalizes,
  while the controller signal tells the omp process to abort the current turn.
- Tool-produced images (e.g. `generate_image`) render in the chat: `handle-omp-run`
  reads `result.details.imagePaths` on `tool_execution_end` and injects a
  `![generated image](<path>)` markdown delta into the assistant stream (emitted
  live and flushed to the assistant message for reload). `MarkdownRenderer`
  rewrites the local path to `/api/hermes/download`, and since omp runs in the
  same container the `/tmp/omp-image-*.png` file resolves — no base64 is stored.
- Usage analytics include omp: `handle-omp-run` now records omp's *reported*
  per-call usage (summed input/output/cache + the run model) to `session_usage`,
  not message-text estimates. The usage dashboard (`usageStats`) reads Hermes
  native `state.db`, which never sees omp/coding-agent runs, so it now also merges
  `getWebUiUsageStatsBySource(['omp','coding_agent'], …)` from the web-ui DB —
  scoped to those web-ui-only sources to avoid double-counting Hermes-native
  sessions. Cost stays state.db-only (omp/coding-agent cost is not computed).
- `omp` must be on `PATH` (override with `HERMES_OMP_COMMAND`). Known first-cut
  limits: model/provider are passed through to omp only when set (otherwise omp
  uses its own config), multimodal input is sent as text, and context-token
  reporting uses omp's per-turn usage totals.
