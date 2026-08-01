---
date: 2026-07-31
pr: 2226
feature: Legacy Group Chat authority repair and message-scoped participant chains
impact: Repairs authenticated owner/member authority for legacy Rooms without restoring revised or explicitly revoked grants; atomically reconciles super-admin demotion with persisted Group Chat authority, durable handoff fencing, and runtime interruption; adds protocol-v2 message-scoped chains such as `@Hermes → @Codex → @Claude Code → @Hermes`, with stable participant IDs, freely repeatable finite steps, durable server-owned step-index order, visible client preview, strict replay identity, and fail-closed validation at both admission and durable consumption (including the 100-step bound, native non-empty string stable IDs, and rejection of empty or missing persisted chain order instead of falling back to text Mention routing); and keeps the generated Room config OpenAPI request schema explicit and byte-stable across production builds.
---
