# CLAUDE.md — Hermes Web UI Development Guide

## Project Overview

Hermes Web UI is a web dashboard for [Hermes Agent](https://github.com/EKKOLearnAI/hermes-web-ui), a multi-platform AI chat system. It provides session management, scheduled jobs, usage analytics, model configuration, channel management (Telegram, Discord, Slack, WhatsApp, etc.), an integrated terminal, and a streaming chat interface.

The project is designed for **multi-agent extensibility** — Hermes is the first agent integration. All agent-specific code is namespaced under `hermes/` directories, so future agents can be added alongside without conflicts.

**Tech stack:**

- **Frontend:** Vue 3 (Composition API, `<script setup lang="ts">`), Naive UI, Pinia, vue-router (hash history), vue-i18n, SCSS, Vite
- **Backend:** Koa 2, @koa/router v15+, node-pty (WebSocket terminal), reverse proxy to Hermes gateway
- **Language:** TypeScript (strict mode), single package (no workspaces)

---

## Development Commands

```bash
npm run dev           # Start both server (nodemon) and client (Vite) concurrently
npm run dev:client    # Vite dev server only (proxies API to backend)
npm run dev:server    # nodemon + ts-node for server only
npm run build         # Type-check (vue-tsc) -> Vite build -> esbuild server bundle
npm run preview       # Preview production build with Vite
npm run test          # Run tests (vitest)
npm run test:watch    # Run tests in watch mode
npm run test:coverage # Run tests with coverage report
```

- **Dev port:** 8648 (client Vite dev server proxies `/api`, `/v1`, `/health`, `/upload`, `/webhook` to `http://127.0.0.1:8648`)
- **Prerequisite:** `hermes` CLI must be installed and on `$PATH` (the server wraps it via `child_process.execFile`)

---

## Project Structure

```
hermes-web-ui/
├── bin/                          # CLI entry point (bin/hermes-web-ui.mjs)
├── dist/                         # Build output
│   ├── client/                   # Vite frontend build
│   └── server/                   # esbuild server bundle
├── packages/
│   ├── client/src/               # Vue 3 frontend
│   │   ├── api/                  # API layer
│   │   │   ├── client.ts         # Shared: base request utility (auth, fetch wrapper)
│   │   │   └── hermes/           # Hermes-specific API modules
│   │   │       ├── chat.ts       # Gateway proxy: runs, SSE events, models
│   │   │       ├── jobs.ts       # Gateway proxy: scheduled jobs CRUD
│   │   │       ├── sessions.ts   # Local BFF: session management (wraps hermes CLI)
│   │   │       ├── profiles.ts   # Local BFF: profile management (wraps hermes CLI)
│   │   │       ├── config.ts     # Local BFF: app config, weixin credentials
│   │   │       ├── logs.ts       # Local BFF: log file listing & reading
│   │   │       ├── skills.ts     # Local BFF: skills listing, memory CRUD
│   │   │       ├── gateways.ts   # Local BFF: gateway management
│   │   │       ├── codex-auth.ts # Local BFF: Codex authentication
│   │   │       └── system.ts     # Local BFF: health, model config, providers
│   │   ├── composables/          # Vue composables
│   │   │   ├── useKeyboard.ts    # Keyboard shortcut composable
│   │   │   └── useTheme.ts       # Theme management composable
│   │   ├── components/           # Vue components
│   │   │   ├── layout/           # Shared: AppSidebar, LanguageSwitch, ModelSelector, ProfileSelector, ThemeSwitch
│   │   │   └── hermes/           # Hermes-specific components
│   │   │       ├── chat/         # ChatPanel, ChatInput, MessageList, MessageItem, MarkdownRenderer
│   │   │       ├── jobs/         # JobCard, JobFormModal, JobsPanel
│   │   │       ├── models/       # ProviderCard, ProviderFormModal, ProvidersPanel, CodexLoginModal
│   │   │       ├── profiles/     # ProfileCard, ProfileCreateModal, ProfileImportModal, ProfileRenameModal, ProfilesPanel
│   │   │       ├── settings/     # AgentSettings, DisplaySettings, MemorySettings, ModelSettings, PlatformCard, PlatformSettings, PrivacySettings, SessionSettings, SettingRow
│   │   │       ├── skills/       # SkillList, SkillDetail
│   │   │       └── usage/        # StatCards, DailyTrend, ModelBreakdown
│   │   ├── i18n/locales/         # en, zh, de, es, fr, ja, ko, pt
│   │   ├── router/index.ts       # vue-router (hash history)
│   │   ├── stores/               # Pinia stores
│   │   │   └── hermes/           # Hermes-specific stores
│   │   │       ├── app.ts        # App-level state (health, sidebar, models)
│   │   │       ├── chat.ts       # Chat sessions, messages, streaming
│   │   │       ├── jobs.ts       # Scheduled jobs CRUD
│   │   │       ├── models.ts     # Model provider management
│   │   │       ├── settings.ts   # App configuration
│   │   │       ├── usage.ts      # Usage statistics
│   │   │       ├── gateways.ts   # Gateway management
│   │   │       └── profiles.ts   # Profile management
│   │   ├── styles/               # global.scss, variables.scss, code-block.scss, theme.ts
│   │   └── views/                # Page-level components
│   │       ├── LoginView.vue     # Shared: login page
│   │       └── hermes/           # Hermes-specific pages
│   │           ├── ChatView.vue
│   │           ├── JobsView.vue
│   │           ├── ModelsView.vue
│   │           ├── ProfilesView.vue
│   │           ├── GatewaysView.vue
│   │           ├── LogsView.vue
│   │           ├── UsageView.vue
│   │           ├── SkillsView.vue
│   │           ├── MemoryView.vue
│   │           ├── SettingsView.vue
│   │           ├── ChannelsView.vue
│   │           └── TerminalView.vue
│   ├── server/src/               # Koa BFF server
│   │   ├── controllers/          # Request handlers (thin routes delegate to controllers)
│   │   │   ├── health.ts         # Health check
│   │   │   ├── update.ts         # Update check
│   │   │   ├── upload.ts         # File upload
│   │   │   ├── webhook.ts        # Incoming webhooks
│   │   │   └── hermes/           # Hermes-specific controllers
│   │   │       ├── sessions.ts   # Session CRUD
│   │   │       ├── profiles.ts   # Profile management
│   │   │       ├── config.ts     # App config read/write
│   │   │       ├── gateways.ts   # Gateway management
│   │   │       ├── codex-auth.ts # Codex authentication
│   │   │       ├── memory.ts     # Memory CRUD
│   │   │       ├── models.ts     # Model configuration
│   │   │       ├── providers.ts  # Provider management
│   │   │       ├── skills.ts     # Skills listing
│   │   │       ├── logs.ts       # Log file listing & reading
│   │   │       └── weixin.ts     # Weixin QR code & credentials
│   │   ├── routes/               # Route modules
│   │   │   ├── index.ts          # Route registration (public → auth → protected)
│   │   │   ├── health.ts         # Health route
│   │   │   ├── update.ts         # Update route
│   │   │   ├── upload.ts         # File upload route
│   │   │   ├── webhook.ts        # Webhook route
│   │   │   └── hermes/           # Hermes-specific routes (thin wrappers)
│   │   │       ├── sessions.ts   # Session routes
│   │   │       ├── profiles.ts   # Profile routes
│   │   │       ├── config.ts     # Config routes
│   │   │       ├── gateways.ts   # Gateway routes
│   │   │       ├── codex-auth.ts # Codex auth routes
│   │   │       ├── memory.ts     # Memory routes
│   │   │       ├── models.ts     # Model routes
│   │   │       ├── providers.ts  # Provider routes
│   │   │       ├── skills.ts     # Skills routes
│   │   │       ├── logs.ts       # Log routes
│   │   │       ├── weixin.ts     # Weixin routes
│   │   │       ├── terminal.ts   # WebSocket terminal (node-pty)
│   │   │       ├── proxy.ts      # Reverse proxy routes + middleware
│   │   │       └── proxy-handler.ts  # Proxy forwarding logic
│   │   ├── services/             # Business logic
│   │   │   ├── auth.ts           # Auth middleware & token management
│   │   │   ├── config.ts         # Server configuration
│   │   │   ├── config-helpers.ts # Config helper utilities
│   │   │   ├── logger.ts         # Pino logger
│   │   │   ├── shutdown.ts       # Graceful shutdown handler
│   │   │   ├── gateway-bootstrap.ts  # Gateway manager initialization
│   │   │   └── hermes/           # Hermes-specific services
│   │   │       ├── hermes-cli.ts # Hermes CLI wrapper (child_process.execFile)
│   │   │       ├── hermes.ts     # Hermes gateway helpers
│   │   │       ├── hermes-profile.ts  # Profile management helpers
│   │   │       ├── gateway-manager.ts # Gateway process management
│   │   │       └── sessions-db.ts    # SQLite-based session database
│   │   ├── shared/providers.ts   # Provider model catalogs
│   │   └── index.ts              # Bootstrap, middleware setup, SPA fallback
│   └── client/src/shared/        # Frontend shared types (providers.ts)
├── scripts/                      # Build scripts
│   ├── build-server.mjs          # esbuild server bundling
│   └── setup.sh                  # Setup script
├── tests/                        # Test files
│   ├── client/                   # Frontend tests
│   └── server/                   # Backend tests
├── package.json                  # Single package — no workspaces
├── vite.config.ts                # root: packages/client, outDir: dist/client
├── vitest.config.ts              # Vitest test configuration
└── tsconfig.json                 # Root tsconfig (references for vue-tsc)
```

---

## Naming Conventions

### Multi-Agent Namespacing

All agent-specific code lives under `{agent-name}/` subdirectories. Hermes is the first agent:

| Layer | Shared | Hermes |
|-------|--------|--------|
| API | `api/client.ts` | `api/hermes/*.ts` |
| Components | `components/layout/` | `components/hermes/*/*.vue` |
| Views | `views/LoginView.vue` | `views/hermes/*.vue` |
| Stores | _(future: `stores/app.ts`)_ | `stores/hermes/*.ts` |
| Controllers | `controllers/*.ts` | `controllers/hermes/*.ts` |
| Routes | `routes/*.ts` | `routes/hermes/*.ts` |
| Services | `services/*.ts` | `services/hermes/*.ts` |
| Routes (URL) | `path: '/'` (login) | `path: '/hermes/*'`, `name: 'hermes.*'` |
| API paths | `/health`, `/upload`, `/webhook` | `/api/hermes/*` |

When adding a new agent, create a new directory at each layer following the same pattern.

### Route Naming

- **Shared routes:** `login`
- **Agent routes:** `{agent}.{page}` — e.g., `hermes.chat`, `hermes.jobs`, `hermes.profiles`, `hermes.gateways`
- **Route paths:** `/hermes/{page}` — e.g., `/hermes/chat`, `/hermes/jobs`

---

## Frontend Conventions

### Vue Components

All components use `<script setup lang="ts">` with the Composition API:

```vue
<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NModal, useMessage } from 'naive-ui'
import { someApi } from '@/api/hermes/something'

const { t } = useI18n()
const message = useMessage()
const loading = ref(false)

async function handleAction() {
  loading.value = true
  try {
    await someApi()
    message.success(t('common.saved'))
  } catch {
    message.error(t('common.saveFailed'))
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="my-component">
    <NButton :loading="loading" @click="handleAction">{{ t('common.save') }}</NButton>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.my-component {
  padding: 16px;
}
</style>
```

Key patterns:
- Import Naive UI components directly from `naive-ui`
- Use `useMessage()` for toast notifications
- Use `useI18n()` for translations, access via `t('key.path')`
- Scoped SCSS with `@use '@/styles/variables' as *`

### Vue Composables

Shared composables live in `packages/client/src/composables/`:

- `useKeyboard.ts` — keyboard shortcut handling
- `useTheme.ts` — theme management (dark/light mode)

### Pinia Stores

Use setup store syntax (function passed to `defineStore`):

```ts
import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useMyStore = defineStore('myStore', () => {
  const items = ref<Item[]>([])
  const loading = ref(false)

  async function fetchItems() {
    loading.value = true
    try {
      items.value = await apiCall()
    } finally {
      loading.value = false
    }
  }

  return { items, loading, fetchItems }
})
```

Existing stores in `packages/client/src/stores/hermes/`: `app`, `chat`, `jobs`, `models`, `settings`, `usage`, `gateways`, `profiles`.

### API Layer

Agent-specific API modules live in `api/{agent}/`. The shared base `api/client.ts` provides:

- `request<T>(path, options)` — typed fetch wrapper with automatic `Authorization: Bearer` header and global 401 handling (clears token, redirects to login)
- `getApiKey()` / `setApiKey()` / `clearApiKey()` — token management via `localStorage`
- `getBaseUrlValue()` — configurable server URL from `localStorage`

```ts
// packages/client/src/api/hermes/sessions.ts
import { request } from '../client'

export async function fetchSessions(source?: string, limit?: number): Promise<SessionSummary[]> {
  const params = new URLSearchParams()
  if (source) params.set('source', source)
  if (limit) params.set('limit', String(limit))
  const query = params.toString()
  const res = await request<{ sessions: SessionSummary[] }>(`/api/hermes/sessions${query ? `?${query}` : ''}`)
  return res.sessions
}
```

**API path rules:**
- Local BFF endpoints: `/api/hermes/{resource}` — handled by Koa routes, call Hermes CLI directly
- Gateway proxy endpoints: `/api/hermes/v1/*`, `/api/hermes/jobs/*` — forwarded to upstream Hermes gateway
- Shared endpoints: `/health`, `/upload`, `/webhook` — no agent prefix

### i18n

Eight locales in `packages/client/src/i18n/locales/`: `en`, `zh`, `de`, `es`, `fr`, `ja`, `ko`, `pt`. Flat nested object structure organized by feature section:

```ts
// en.ts
export default {
  chat: {
    emptyState: 'Start a conversation with Hermes Agent',
    inputPlaceholder: 'Type a message...',
    sessions: 'Sessions',
    // ...
  },
  common: {
    save: 'Save',
    cancel: 'Cancel',
    delete: 'Delete',
    // ...
  },
}
```

When adding new strings, add to all locale files.

### SCSS Styling

- Global variables in `packages/client/src/styles/variables.scss` — import with `@use '@/styles/variables' as *`
- Naive UI theme overrides in `packages/client/src/styles/theme.ts`
- Code block styling in `packages/client/src/styles/code-block.scss`
- Theme: "Pure Ink" (monochrome black/white/gray), no color accent
- Mobile breakpoint: `$breakpoint-mobile: 768px`
- Global resets and shared classes in `packages/client/src/styles/global.scss`
- Component styles are always `<style scoped lang="scss">`

### Router

Hash-based routing (`createWebHashHistory`). All routes use lazy imports. Auth guard in `router.beforeEach` redirects unauthenticated users to `/` (login). Public routes use `meta: { public: true }`.

```ts
// Agent route example
{
  path: '/hermes/chat',
  name: 'hermes.chat',
  component: () => import('@/views/hermes/ChatView.vue'),
}
```

---

## Backend Conventions

### Architecture: Routes + Controllers

The backend follows a **thin-router, fat-controller** pattern:

- **Routes** (`routes/`) — define URL-to-handler mappings, delegate to controller functions
- **Controllers** (`controllers/`) — contain the actual request handling logic
- **Services** (`services/`) — reusable business logic, CLI wrappers, utilities

### Koa Server (`packages/server/src/index.ts`)

The server bootstraps in `bootstrap()`:
1. Creates data/upload directories
2. Gets auth token
3. Creates Koa app, initializes gateway manager
4. Registers CORS, body parser
5. Registers all routes via `registerRoutes()` (public routes → auth middleware → protected routes)
6. Registers proxy middleware (catch-all for unmatched `/api/hermes/*` and `/v1/*`)
7. Serves static SPA files with fallback to `index.html`
8. Starts server, sets up WebSocket handler
9. Binds graceful shutdown handler, starts version check

### Route Registration (`packages/server/src/routes/index.ts`)

All routes are registered in a specific order:
1. **Public routes** (no auth): health, webhook
2. **Auth middleware** (`requireAuth`)
3. **Protected routes**: upload, update, session, profile, skill, memory, model, provider, config, log, codex-auth, gateway, weixin, proxy

**Important:** Custom API endpoints handled locally (not proxied) must be registered in `routes/index.ts` **before** `proxyRoutes`. The proxy catch-all matches all `/api/hermes/*` paths.

### Route Modules

Each route module exports a `Router` instance with thin handler delegation:

```ts
// packages/server/src/routes/hermes/sessions.ts
import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/sessions'

export const sessionRoutes = new Router()

sessionRoutes.get('/api/hermes/sessions', ctrl.list)
sessionRoutes.get('/api/hermes/sessions/:id', ctrl.get)
sessionRoutes.delete('/api/hermes/sessions/:id', ctrl.remove)
sessionRoutes.post('/api/hermes/sessions/:id/rename', ctrl.rename)
```

**@koa/router v15 syntax** (path-to-regexp v8):
- Parameters: `:id` (single segment) or `{*path}` (wildcard, matches `/`)
- No regex groups `(.*)` — use `{*name}` instead
- No modifiers `:id+` or `:id*` — use `{*name}`

### Reverse Proxy

Unmatched `/api/hermes/*` and `/v1/*` requests are forwarded to the upstream Hermes gateway (`http://127.0.0.1:8642`). Path rewriting in `proxy-handler.ts`:

- `/api/hermes/v1/*` → `/v1/*` (upstream uses `/v1/` prefix)
- `/api/hermes/*` → `/api/*` (upstream uses `/api/` prefix)

The proxy is implemented as both a route (`proxyRoutes.all('/api/hermes/{*any}', proxy)`) and a middleware (`proxyMiddleware`) registered on the main app to catch any requests that slip through route matching.

### Hermes CLI Wrapper (`packages/server/src/services/hermes/hermes-cli.ts`)

All Hermes interactions go through `child_process.execFile('hermes', [...args])`. Each function wraps a CLI subcommand:

```ts
export async function listSessions(source?: string, limit?: number): Promise<HermesSession[]> {
  const { stdout } = await execFileAsync('hermes', ['sessions', 'export', '-'], {
    maxBuffer: 50 * 1024 * 1024,
    timeout: 30000,
  })
  // Parse newline-delimited JSON output
}
```

CLI subcommands wrapped: `sessions export/delete/rename`, `profile list/show/create/delete/rename/use/export/import`, `gateway start/restart/stop`, `logs list/read`, `--version`.

### Auth Middleware (`packages/server/src/services/auth.ts`)

- Token stored in `~/.hermes-web-ui/.token` (auto-generated on first run), or set via `AUTH_TOKEN` env var
- Auth disabled when `AUTH_DISABLED=1`
- Applied globally after public routes (health, webhook are registered before auth middleware)
- For non-API paths (static files), auth is skipped even if no valid token is provided
- Accepts `Authorization: Bearer <token>` header or `?token=<token>` query param

---

## Build System

- **Vite** builds the frontend: root is `packages/client`, output goes to `dist/client`
- **esbuild** bundles the server via `scripts/build-server.mjs`: output goes to `dist/server`
- **tsc** type-checks both client (`vue-tsc -b`) and server (`tsc --noEmit`)
- Path alias: `@` maps to `packages/client/src`
- Build command: `vue-tsc -b && vite build && tsc --noEmit -p packages/server/tsconfig.json && node scripts/build-server.mjs`
- TypeScript strict mode enabled for both client and server

---

## Key Patterns

### SSE Streaming (Chat)

Chat uses Server-Sent Events via `EventSource`:

```ts
// packages/client/src/api/hermes/chat.ts
export function streamRunEvents(runId, onEvent, onDone, onError) {
  const url = `${baseUrl}/api/hermes/v1/runs/${runId}/events?token=...`
  const source = new EventSource(url)

  source.onmessage = (e) => {
    const parsed = JSON.parse(e.data)
    onEvent(parsed)
    if (parsed.event === 'run.completed' || parsed.event === 'run.failed') {
      source.close()
      onDone()
    }
  }
}
```

Auth token is passed via query parameter since `EventSource` does not support custom headers.

### WebSocket Terminal

Terminal uses a raw WebSocket at `/api/hermes/terminal` with JSON control messages:

- Client sends: `{ type: "create" }`, `{ type: "switch", sessionId }`, `{ type: "close", sessionId }`, `{ type: "resize", cols, rows }`
- Client sends raw strings as keyboard input to the active PTY session
- Server sends raw PTY output strings and JSON messages like `{ type: "created", id, pid, shell }`, `{ type: "exited", id, exitCode }`
- Uses `node-pty` for pseudo-terminal, `@xterm/xterm` for frontend rendering
- Auth via `?token=` query parameter on WebSocket upgrade

---

## Testing

Tests use **Vitest** with `@vue/test-utils` and `@pinia/testing` for frontend, and `vitest` for backend:

```bash
npm run test          # Run all tests once
npm run test:watch    # Watch mode
npm run test:coverage # With coverage report
```

Test files live in `tests/client/` and `tests/server/`. Configuration is in root `vitest.config.ts`.

---

## Environment Variables

| Variable | Description |
|---|---|
| `AUTH_DISABLED` | Set to `1` or `true` to disable auth |
| `AUTH_TOKEN` | Custom auth token (overrides auto-generated token) |
| `PORT` | Server listen port (default `8648`) |
| `UPSTREAM` | Hermes gateway URL (default `http://127.0.0.1:8642`) |
| `UPLOAD_DIR` | Custom upload directory path (default OS temp dir) |
| `CORS_ORIGINS` | CORS origin configuration (default `*`) |
| `HERMES_BIN` | Custom path to hermes CLI binary |

---

## Common Tasks

### Add a new Hermes page

1. Create view component in `packages/client/src/views/hermes/MyView.vue`
2. Add route in `packages/client/src/router/index.ts` with name `hermes.myPage` and path `/hermes/my-page`
3. Add sidebar entry in `packages/client/src/components/layout/AppSidebar.vue` with `handleNav('hermes.myPage')`
4. Add i18n keys to all locale files in `packages/client/src/i18n/locales/`

### Add a new Hermes API endpoint

1. Add the controller in `packages/server/src/controllers/hermes/` (request handling logic)
2. Add the route in `packages/server/src/routes/hermes/` (thin URL-to-controller mapping)
3. Register the route in `packages/server/src/routes/index.ts` in the protected routes section
4. If it calls Hermes CLI, add a wrapper function in `packages/server/src/services/hermes/hermes-cli.ts`
5. Add the frontend API function in `packages/client/src/api/hermes/`
6. If the endpoint should be proxied to the upstream gateway (not handled locally), ensure the path starts with `/api/hermes/` — the `proxyMiddleware` will catch it automatically

### Add a new Hermes Pinia store

1. Create `packages/client/src/stores/hermes/myFeature.ts` using setup syntax
2. Export `useMyFeatureStore` from the module

### Add a new agent integration

1. Create `api/{agent}/`, `components/{agent}/`, `views/{agent}/`, `stores/{agent}/` directories
2. Create `controllers/{agent}/`, `routes/{agent}/`, `services/{agent}/` for agent-specific backend
3. Add routes with `path: '/{agent}/*'` and `name: '{agent}.*'` in the router
4. Register routes in `routes/index.ts` following the public → auth → protected pattern
5. Follow the same patterns as the Hermes integration
