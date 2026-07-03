---
date: 2026-07-03
commit: local
feature: Workspace folder picker
impact: Workspace folder browsing now includes dot-prefixed directories such as .hermes, .config, and .codex while preserving WORKSPACE_BASE containment checks; chat session creation, message ordering, and runtime transport behavior are unchanged.
---

# Dot-prefixed workspace folders

Changed file: `packages/server/src/controllers/hermes/sessions.ts`

The workspace folder picker no longer hides directories whose names start with a dot. Hidden or tool-owned directories can now be selected as valid workspaces when they are inside the configured workspace base. Existing directory type checks, symlink handling, and path containment validation remain in place.
