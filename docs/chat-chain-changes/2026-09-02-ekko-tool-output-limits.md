# Ekko tool output limits

- Date: 2026-09-02
- Area: direct chat / Ekko Agent tool execution
- Change: bound `terminal_exec` stdout and stderr previews, persist capped oversized-stream artifacts under the ignored workspace temporary directory, and add a provider-request safety limit for every textual tool result that still returns a preview when artifact persistence fails.
- Impact: large command output remains available for paged `read_file` access or bounded searches without placing multi-megabyte tool results into the same model request or allowing an unbounded artifact to exhaust local disk space.
- UX: tool-call progress text must be a complete sentence, and dangling `:` / `：` preambles are normalized before they are persisted or reused as model context.
