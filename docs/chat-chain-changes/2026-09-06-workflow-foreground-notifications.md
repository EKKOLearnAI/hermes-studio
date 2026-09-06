# Workflow foreground result notifications

Emit app.workflow-notification for persisted completed/failed whole runs only, dedupe per run ID, and recheck authenticated profile access at send time. No node/status snapshot replay, cancel alerts or approval notifications. Companion App opens exact run details. No raw error text or output is included in the initial compact version.
