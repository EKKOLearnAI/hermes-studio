---
date: 2026-07-12
pr: pending
commit: pending
feature: workflow-edge-policy-editor
impact: workflow editor
---

# Workflow edge policy editor

- Opens a declarative policy editor when an editable workflow edge is clicked.
- Supports success, failure, and always routes plus fixed condition operators.
- Parses condition values as JSON and blocks malformed values before saving.
- Preserves edge orchestration data across workflow load and save without executable expressions.
