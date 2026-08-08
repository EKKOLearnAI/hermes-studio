---
date: 2026-08-08
pr: pending
feature: group-chat-tool-result-correlation-scope
impact: Tool completion recovery state is isolated per Room and native Session, preventing cross-run overwrite when runtimes reuse a Tool call ID.
---

- Scope internal Tool completion correlation by Room and native Session while preserving the runtime's external `tool_call_id` in persisted messages.
- Prevent concurrent Group Chat runs that reuse the same native Tool call ID from overwriting each other's retry payload, Run ID, or acknowledgement state.
- Keep deterministic persisted Tool call/result IDs within each Run and preserve legacy implicit Assistant mention handoffs.
