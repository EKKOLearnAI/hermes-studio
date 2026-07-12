---
date: 2026-07-12
pr: pending
commit: pending
feature: workflow-output-handle-drop
impact: workflow editor
---

- Accepts only output/source connection drags from an existing node.
- Uses the actual canvas drop point for the new Hermes Agent node.
- Connects the node with a default declarative `success` edge.
- Keeps historical run snapshots read-only and ignores drops on nodes, edges, handles, controls, or the minimap.
