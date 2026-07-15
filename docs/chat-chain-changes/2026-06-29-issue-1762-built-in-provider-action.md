---
date: 2026-06-29
pr: 1840
feature: Models built-in provider destructive action wording
impact: Built-in providers no longer present their credential-clearing/disable action as a removable provider delete.
---

Provider cards keep the Delete action for config-backed custom providers, but built-in providers now show either `Clear credentials` or `Disable provider` with matching confirmation and success text so users are not told a built-in provider was removed when it remains part of the built-in catalog.
