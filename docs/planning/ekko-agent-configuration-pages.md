# Ekko Agent configuration pages

Date: 2026-08-28
Status: Implemented (awaiting review)

## Goal

Give the built-in Ekko Agent its own configuration surface in Studio, following
the same shell pattern as Hermes configuration: independent routes, a dedicated
collapsible/mobile sidebar, profile-aware data, and a clear return path to the
Agent Manager.

The first release covers three Ekko-owned capabilities:

- structured long-term memory;
- profile-local skills;
- profile-local MCP server configuration.

## Navigation and shell

The Ekko card in `/studio/agents` opens the Ekko configuration surface. The
surface uses route metadata (`ekkoConfig`) so `App.vue` can mount an
`EkkoConfigSidebar` instead of the Studio sidebar or the Hermes configuration
sidebar.

Routes:

```text
/ekko/memory  -> ekko.memory
/ekko/skills  -> ekko.skills
/ekko/mcp     -> ekko.mcp
```

The sidebar contains Memory, Skills, and MCP, plus a footer action returning to
the Agent Manager. Hermes and Ekko use the same sidebar layout stylesheet for
desktop collapse state, mobile backdrop/navigation, the shared mobile-open
event, custom backgrounds, and desktop drag regions.

## Server ownership and APIs

All new HTTP operations are owned by `modules/ekko` and use `/api/ekko/*`.
Routes stay thin, controllers validate request input, and services adapt the
public `ekko-agent` package managers.

### Memory

```text
GET    /api/ekko/memory
PATCH  /api/ekko/memory/:id
DELETE /api/ekko/memory/:id
```

The list endpoint is profile-scoped and supports text/status filtering. Updates
must include the current revision and create a new canonical revision through
`MemoryService.update`; deletion is soft by default and also requires the
current revision. The page does not edit Ekko's memory database directly.

### Skills

```text
GET    /api/ekko/skills
GET    /api/ekko/skills/:name
POST   /api/ekko/skills
PUT    /api/ekko/skills/:name
DELETE /api/ekko/skills/:name
```

Operations use `EkkoSkillManager`, preserving its discovery, read-before-write,
managed-skill, and path-containment rules. The page manages each profile's
`SKILL.md`; support-file editing and imports are deferred.

### MCP

```text
GET    /api/ekko/mcp/servers
POST   /api/ekko/mcp/servers
PATCH  /api/ekko/mcp/servers/:name
DELETE /api/ekko/mcp/servers/:name
POST   /api/ekko/mcp/servers/:name/test
```

Custom stdio and Streamable HTTP server definitions are stored in Ekko's canonical
`.ekko/config/config.json` under `mcp.profiles.<profile>.servers`; there is no
Studio-owned MCP sidecar. Ekko validates this module with the rest of its config
and loads the selected Profile's servers into newly created runtimes. During
Studio startup, the same four managed definitions used by Hermes are injected
into each Ekko Profile. As on the Hermes MCP page, those injected entries can be
edited, removed, enabled, or disabled; an existing `enabled: false` value is
preserved across reinjection. The API and page read and write that same config
module, so changes affect subsequent runs.

## Client behavior

- Every page uses the active profile already attached by the shared API client.
- Memory shows searchable cards with status/type metadata and an edit modal.
- Skills directly reuses Hermes' `SkillList` and `SkillDetail` components plus
  the shared split-view layout; only its data callbacks use the Ekko API.
- MCP directly reuses Hermes' `McpServerCard` plus the shared manager layout for
  summary cards, search toolbar, responsive server grid, tool tags, and the
  JSON/YAML editor. Ekko-specific behavior is limited to its API adapter and
  transport-aware validation and background tool probing.
- Loading, empty, error, confirmation, and mutation states remain local to each
  page.
- New visible strings are present in every locale file.

## Validation

- focused server tests for profile isolation, memory revision safety, skill
  manager adaptation, MCP persistence/validation, and runtime merging;
- focused client tests for routes, shell/sidebar wiring, Agent Manager entry,
  and the three page request flows;
- `npm run harness:check`;
- `npm run build`;
- browser-visible validation when the configured Playwright browser is
  available.

## Deferred work

- Memory audit-history and hard-delete UI;
- skill support files, archive/import, and external directories;
- legacy HTTP+SSE MCP transport fallback;
- per-tool include/exclude controls and long-lived connection telemetry.
