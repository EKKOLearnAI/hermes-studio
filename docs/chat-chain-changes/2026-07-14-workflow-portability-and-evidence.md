---
date: 2026-07-14
pr: 2073
feature: Portable Workflow import and durable execution evidence
impact: Workflow exports carry graph behavior without source-profile model bindings, legacy v1 imports are sanitized for cross-environment reuse, and every persisted node execution now references a durable local Session before the runner starts.
---

Workflow import remains bound to the requesting user and target profile, while
provider/model/API-mode/reasoning bindings are resolved by the destination
profile instead of being copied from the source environment. Capability and
skill checks still fail closed immediately before execution.

Loop feedback now evaluates the actual iteration outcome, approval cancellation
remains canceled, archived edge-evidence indexes are recreated on the active
table, and the evidence drawer omits normal node rows already replayed on the
canvas while retaining routes, loops, and exceptional node outcomes.
