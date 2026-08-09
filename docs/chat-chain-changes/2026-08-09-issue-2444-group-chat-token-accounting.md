---
date: 2026-08-09
pr: 2445
feature: Bounded Group Chat token accounting
impact: Group Chat message persistence maintains the cached context-window total from canonical stored content and uses allocation-safe linear estimation for oversized text so HTTP health checks remain responsive under production-sized tool results.
---

The canonical context window remains 500 messages and preserves ordinary same-timestamp multipart boundaries with a bounded overflow allowance. Pathological same-timestamp floods are capped so a malformed or adversarial room cannot make one persistence turn unbounded. Equal-timestamp cursor ordering now uses the same binary string order as SQLite, including mixed-case and non-ASCII IDs. Workspace diff messages continue to be excluded from the shared context total.

Cached room totals carry an accounting version. Existing installations receive version `0` through the additive schema migration, and every legacy-room write path—including new and replayed workspace diffs—rebuilds the bounded context cache before returning it. New rooms start at the current version; startup does not synchronously retokenize every historical room.

Token deltas are charged from the canonical content actually persisted after multimodal/data-image normalization. Oversized token estimation scans without materializing a regex match array or relying on predictable sample positions, preventing adversarial text layouts from hiding most CJK content.
