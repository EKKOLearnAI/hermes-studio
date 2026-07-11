---
date: 2026-07-11
pr: pending
feature: Gateway session history visibility and per-source quota
impact: Gateway sessions (WeChat, DingTalk, Feishu, QQ, WeCom, subagent) now appear in the Chat session list and History page. The session list query now uses per-source quota (ROW_NUMBER OVER PARTITION BY source) instead of a global LIMIT, preventing cron sessions from drowning out all other sources.
---

`listSessionSummaries()` in `sessions-db.ts` now ranks sessions within each
source by last-active timestamp (`MAX(messages.timestamp)`) and picks the top
N per source instead of a single global `ORDER BY started_at DESC LIMIT 2000`.

`isVisibleWebUiSessionSource()` in `sessions.ts` now includes gateway sources
(`weixin`, `wecom`, `dingtalk`, `feishu`, `qqbot`, `subagent`) so the Chat
panel and search endpoints return them. Previously only `api_server`, `cli`,
`coding_agent`, and `global_agent` were whitelisted.
