# Chat chain changes for PR #1682 — Custom backend connection settings

- **Date**: 2026-06-20
- **PR**: #1682
- **Files changed**:
  - `packages/client/src/stores/hermes/chat.ts` — `uploadFiles` now respects `getBaseUrlValue()` for custom backend URL
  - `packages/client/src/stores/hermes/group-chat.ts` — `uploadFiles` now respects `getBaseUrlValue()` for custom backend URL
- **Behavior impact**: When a custom backend server address is configured in ConnectionSettings, file uploads in both chat and group-chat use the custom base URL instead of the current page origin. No change when no custom backend is configured (same-origin behavior preserved).
