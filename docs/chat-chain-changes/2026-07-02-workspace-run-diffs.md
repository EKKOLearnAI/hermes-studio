---
date: 2026-07-02
pr: 1895
feature: Workspace run diffs
impact: Chat sessions can show workspace file changes produced by Hermes and coding-agent runs.
---

Run-level workspace diffs are captured at run start/end, persisted in workspace
diff tables, and rendered as synthetic chat cards below the relevant assistant
response. Live delivery is supported through `workspace.diff.completed` and a
terminal-event `workspace_run_change` fallback, with relay support for
global-agent paths.

The UI restores diff cards after resume/tab visibility message remaps, preserves
multiple run diffs in the same session with unique change ids, opens file diffs
in a right-side drawer, supports editing changed files from the drawer, and uses
separate light/dark card colors. The editor drawer loads the file editor lazily
so normal message rendering does not initialize the editor stack.
