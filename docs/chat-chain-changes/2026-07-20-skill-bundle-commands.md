---
date: 2026-07-20
pr: pending
feature: Profile-scoped skill bundle commands
impact: Hermes chat can browse, create, and delete Profile-scoped skill bundles with /bundles, then execute them with optional instructions while keeping /skill limited to normal skills.
---

`/bundles <bundle-name> [instructions]` expands through the existing Agent Bridge
command path and preserves the visible command when the expanded prompt starts or
queues a run. `/bundles` and `/bundles create` are intercepted by the chat input to
open the Bundle picker and creator without sending a runtime command. Bundle names
use English identifiers, and list/delete operations stay scoped to the session Profile.
