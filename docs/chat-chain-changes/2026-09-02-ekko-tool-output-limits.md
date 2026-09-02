# Ekko tool output limits

- Date: 2026-09-02
- Area: direct chat / Ekko Agent tool execution
- Change: bound `terminal_exec` stdout and stderr previews, persist oversized streams under the workspace temporary directory, and add a provider-request safety limit for every textual tool result.
- Impact: large command output remains available for paged `read_file` access or bounded searches without placing multi-megabyte tool results into the same model request.
