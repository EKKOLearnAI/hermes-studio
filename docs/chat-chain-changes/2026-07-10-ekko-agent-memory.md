---
date: 2026-07-10
pr: pending
feature: Ekko Agent chained memory
impact: Ekko Agent retrieves scoped SQLite memory before model calls, records every completed run, and periodically extracts auditable memory in batches.
---

Ekko Agent owns a generic database through its dedicated database manager.
Development uses `packages/ekko-agent/sql-data/ekko-agent.db` with the same
single-file SQLite/DELETE journal layout as the server development database;
production uses `HERMES_WEB_UI_HOME/ekko/ekko.db`. Memory initialization
failures degrade the memory feature without blocking the existing chat run.

After a successful Ekko Agent run, raw conversation messages are always stored,
but model-based memory review waits until eight new user messages have
accumulated. A manual review can bypass that threshold, which provides a hook
for future session-end or idle-time review. Each review reuses the selected chat
model in a separate non-streaming request. That request receives only the four
memory tools and a bounded input containing the previous rolling summary plus
the accumulated new messages. It does not receive filesystem, terminal, browser, MCP, skill, or
other runtime tools. The model writes durable nodes through validated memory
tools and returns structured rolling session state as JSON. The server clears
unsupported active goals, filters transient metrics and unsupported strengthened
claims, and deterministically builds the stored summary. Summary requests retry
three times, and malformed JSON gets one repair request. If all attempts fail,
the service stores a compact safe summary and records the fallback reason in
memory audit without failing the completed chat response.

Memory message IDs remain stable when unrelated messages are inserted into the
history, preventing completed turns from being captured and summarized again.
Tool payloads are excluded from the summarizer transcript. The model returns
the structured summary categories directly, and its prompt excludes completed
weather, news, search, and other time-sensitive lookup details from rolling
active state. With no pending work or known issue, `currentGoal` is forced empty.

Every periodic summarizer model response is attributed in `session_usage` with
`purpose=ekko-memory-summary`, a unique `memory-summary:*` run id, and the
actual provider usage buckets. Main-response usage continues through the
runtime event path, so the two call classes are queryable without double
counting.
