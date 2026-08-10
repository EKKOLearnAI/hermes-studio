---
date: 2026-08-10
pr: 2455
feature: session-scoped-approval-mode-switcher
impact: Chat input gained a three-way approval mode dropdown (manual / smart / off) that sends /approval_mode over the run socket; bridge now enforces the session-scoped approval policy per command instead of using a fixed policy.
---

# Session-scoped approval mode switcher

Adds a three-way approval mode dropdown next to the model selector in the chat input toolbar: manual (user approves), smart (aux LLM auto-approves safe commands), and off (full authorization, mirrors `/yolo` session bypass).

- `ChatInput.vue` — dropdown UI with per-mode icons, a red warning state for full-access, and a confirm dialog when enabling full authorization.
- `chat.ts` store — per-session `approvalModeBySession` state synced from `session.command approval_mode` responses; `setSessionApprovalMode()` sends `/approval_mode` over the existing run socket.
- `bridge_pool.py` — handles `approval_mode` with a per-session mode cache consulted by the approval policy; `smart` uses the aux LLM auto-approval path.
- `session-command.ts` — registers `/approval_mode` (aliases: `/approval-mode`) and validates `manual|smart|off`.
- i18n en/zh/zh-TW labels; `bridge-session-commands.ts` exposes the command definition.
