# feat(mcp): Add MCP Server Management UI

## Summary

Add a complete MCP (Model Context Protocol) server management interface that allows users to manage MCP servers through the web UI. This feature provides a user-friendly way to configure, monitor, and control MCP servers without editing configuration files manually.

## Features

### Core Functionality
- **Server List**: View all configured MCP servers with real-time status indicators (connected/disconnected/disabled)
- **Add Server**: Add new MCP servers with YAML or JSON configuration editor (Monaco Editor)
- **Edit Server**: Modify existing server configurations — uses `raw_config` passthrough to avoid field loss
- **Remove Server**: Delete servers with confirmation dialog to prevent accidental deletion
- **Enable/Disable**: Toggle individual servers on/off with instant feedback
- **Test Connection**: Verify server connectivity and list available tools
- **Reload**: Refresh server configuration without restarting
- **Search/Filter**: Filter servers by name for quick navigation

### User Experience
- **Monaco Editor**: Full-featured code editor with YAML/JSON syntax highlighting
- **Responsive Design**: Works on desktop (1280px), tablet (768px), and mobile (480px)
- **Auto-Retry**: Exponential backoff (2s → 4s → 8s → 16s → 32s, max 5 retries) for servers that haven't connected yet
- **Loading States**: Clear feedback during async operations
- **Error Handling**: User-friendly error messages with actionable guidance
- **Multi-language Support**: 9 languages (English, Chinese Simplified/Traditional, Japanese, Korean, German, Spanish, French, Portuguese)

### Performance Optimizations
- **`raw_config` Passthrough**: Backend returns the original config dict as-is — frontend edits/Toggles use it directly, eliminating field-rebuild bugs
- **`tool_details` Embedding**: `mcp_list` response embeds filtered `{name, description}` per server, reducing first-load from 1+N requests to 1
- **Route Safety**: `hasRoute()` guards for dynamic sidebar routes to prevent Vue runtime crashes

## Technical Implementation

### Frontend (Vue 3 + Naive UI)
- `McpManagerView.vue`: Main management component with auto-retry, search, modal management
- `McpServerCard.vue`: Server card component with status indicators, tool tags, action buttons
- `mcp.ts` (api): Type definitions (`McpServerInfo` with `raw_config`, `tool_details`) and API client
- Monaco Editor integration for configuration editing
- Reactive state management with Vue 3 Composition API

### Backend (Koa + TypeScript)
- `mcp.ts` (controller): Request handlers with input validation
- `mcp.ts` (service): Business logic layer with typed interfaces
- `mcp.ts` (routes): RESTful API endpoints
- `mcp-types.ts`: Shared type definitions
- `client.ts` (bridge): AgentBridge client methods

### Python Bridge (`hermes_bridge.py`)
- `_build_server_entry()`: Normalized server entry builder returning `raw_config` and `tool_details`
- `_mcp_list()`: Lists all MCP servers with embedded filtered tool details
- `_mcp_server_add/update/remove`: Full CRUD with config validation and atomic YAML persistence
- `_mcp_server_toggle`: Enable/disable individual servers
- `_mcp_server_test`: Connection test with tool discovery
- `_mcp_reload`: Hot-reload server connections
- Background MCP discovery on worker startup

### Testing
- `mcp-controller.test.ts`: 19 unit tests covering all controller methods
- Tests for success cases, error handling, and edge cases
- Mock-based testing for isolation

## Files Changed

```
packages/client/src/api/hermes/mcp.ts                          |  87 ++++
packages/client/src/components/hermes/mcp/McpServerCard.vue     | 275 +++++++++
packages/client/src/components/layout/AppSidebar.vue            |  16 +-
packages/client/src/components/hermes/chat/ChatInput.vue        |   1 +
packages/client/src/i18n/locales/{de,en,es,fr,ja,ko,pt,zh,zh-TW}.ts | 504 +++ (9 files)
packages/client/src/i18n/messages.ts                            |   2 +-
packages/client/src/router/index.ts                             |   6 +
packages/client/src/views/hermes/McpManagerView.vue             | 623 +++++++++++++++++
packages/server/src/controllers/hermes/mcp.ts                  | 117 ++++
packages/server/src/routes/hermes/mcp.ts                       |  12 +
packages/server/src/routes/index.ts                            |   2 +
packages/server/src/services/hermes/agent-bridge/client.ts      |  31 +
packages/server/src/services/hermes/agent-bridge/hermes_bridge.py | 368 +++++++++-
packages/server/src/services/hermes/mcp-types.ts               |  67 ++
packages/server/src/services/hermes/mcp.ts                     |  67 ++
packages/server/src/services/hermes/run-chat/session-command.ts |  22 +
tests/server/mcp-controller.test.ts                            | 286 +++++++++
```

**Total**: 27 files changed, ~2,900 insertions

## Testing

### Unit Tests (19/19 passing)
```
✓ MCP Controller > listServers > returns servers list from bridge
✓ MCP Controller > listServers > returns 503 on bridge error
✓ MCP Controller > addServer > sends name and config to bridge
✓ MCP Controller > addServer > returns 400 when name is missing
✓ MCP Controller > addServer > returns 400 when config is missing
✓ MCP Controller > updateServer > sends name from params and config to bridge
✓ MCP Controller > updateServer > returns 400 when config is missing
✓ MCP Controller > removeServer > sends name to bridge
✓ MCP Controller > testServer > returns tool list from bridge
✓ MCP Controller > listTools > returns tools without server filter
✓ MCP Controller > listTools > passes server filter to bridge
✓ MCP Controller > listTools > returns 503 on bridge error
✓ MCP Controller > reloadMcp > reloads all servers when no filter
✓ MCP Controller > reloadMcp > reloads specific server
✓ MCP Controller > reloadMcp > returns 500 on bridge error
✓ MCP Controller > profile handling > passes undefined profile when ctx.state.profile is missing
✓ MCP Controller > profile handling > passes undefined profile when profile.name is empty
✓ MCP Controller > response structure > mcp_list response has all required fields
✓ MCP Controller > response structure > mcp_tools_list response has tools with name/description/schema
```

### UX Browser Tests (8/8 passing)

| Test Case | Screenshot | Result |
|-----------|------------|--------|
| TC-01 Initial State | [mcp-tc01-initial-state.png](docs/images/mcp/mcp-tc01-initial-state.png) | ✅ Summary cards 1/1/0/3, github server connected |
| TC-02 Search Filter | [mcp-tc02-search-git.png](docs/images/mcp/mcp-tc02-search-git.png) | ✅ Correctly filters to github only |
| TC-03 Search Empty | [mcp-tc03-search-empty.png](docs/images/mcp/mcp-tc03-search-empty.png) | ✅ Empty state "暂无 MCP 服务器配置" shown |
| TC-04 Add Modal | [mcp-tc04-add-modal.png](docs/images/mcp/mcp-tc04-add-modal.png) | ✅ JSON/YAML toggle, config editor, Cancel/Save |
| TC-05 Edit Modal | [mcp-tc05-edit-modal.png](docs/images/mcp/mcp-tc05-edit-modal.png) | ✅ Pre-filled config with raw_config passthrough |
| TC-06 Tools Expanded | [mcp-tc06-tools-expanded.png](docs/images/mcp/mcp-tc06-tools-expanded.png) | ✅ Shows 3/26 tool tags |
| TC-07 Responsive 768px | [mcp-tc07-responsive-768.png](docs/images/mcp/mcp-tc07-responsive-768.png) | ✅ Tablet layout, no overflow |
| TC-08 Responsive 480px | [mcp-tc08-responsive-480.png](docs/images/mcp/mcp-tc08-responsive-480.png) | ✅ Mobile layout, all elements accessible |

### Build
- [x] TypeScript compilation successful
- [x] Vite build successful
- [x] No linting errors

## Architecture Decisions

### 1. `raw_config` Passthrough
**Problem**: Rebuilding config from scattered fields (command, args, env, etc.) caused field loss on edit/Toggle.
**Solution**: Backend returns `raw_config` (original dict from config.yaml), frontend edits it directly. Zero rebuild, zero field loss.

### 2. `tool_details` Embedding
**Problem**: First load required 1 API call for server list + N calls for tool details (one per server).
**Solution**: `mcp_list` response embeds `tool_details` (filtered `{name, description}` per server). Single request for full card data.

### 3. Auto-Retry with Exponential Backoff
**Problem**: MCP servers may not be connected on first page load (still initializing).
**Solution**: Auto-retry with exponential backoff (2s, 4s, 8s, 16s, 32s), max 5 retries. Manual refresh resets counter.

### 4. Route Safety Guards
**Problem**: Unknown routes (e.g., `codingAgents`, `versionPreview`) could crash Vue at runtime.
**Solution**: `hasRoute()` checks before rendering dynamic sidebar route items.

## Screenshots

### Desktop (1280px) — Initial State
![MCP Management - Initial State](docs/images/mcp/mcp-tc01-initial-state.png)

### Edit Server Modal
![MCP Management - Edit Modal](docs/images/mcp/mcp-tc05-edit-modal.png)

### Responsive — Mobile (480px)
![MCP Management - Mobile](docs/images/mcp/mcp-tc08-responsive-480.png)

## Checklist

- [x] Code follows project style guidelines
- [x] Self-review completed
- [x] Documentation updated
- [x] Tests added for new functionality (19 unit + 8 UX)
- [x] All tests pass
- [x] No breaking changes
- [x] Multi-language support (9 languages)
- [x] Responsive design verified (desktop/tablet/mobile)
