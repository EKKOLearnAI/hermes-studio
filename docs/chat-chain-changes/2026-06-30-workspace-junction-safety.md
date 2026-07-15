---
date: 2026-06-30
commit: 19f7c180
feature: Workspace folder picker
impact: workspace folder listing and folder mutation path validation hardened for symlink/junction entries; no chat session persistence/runtime chain semantics changed
---

# Workspace folder symlink/junction safety

Changed file: `packages/server/src/controllers/hermes/sessions.ts`

The workspace folder picker now realpath-vets browsed folders and directory symlink/junction-like entries. Safe directory symlinks whose target remains under the workspace base can appear in the picker; escaped targets and mutation paths through escaped symlink ancestors are rejected.

This touches the shared sessions controller file, but it does not alter chat session creation, persistence, message ordering, or runtime transport behavior.
