# Architecture

Hermes Web UI is a TypeScript monorepo that ships a browser dashboard, a Koa
backend, and an Electron desktop distribution around Hermes Agent.

## Package Boundaries

| Area | Path | Responsibility |
| --- | --- | --- |
| Client | `packages/client/src` | Vue UI, routing, Pinia stores, API wrappers, i18n, browser-visible state. |
| Server | `packages/server/src` | HTTP API, auth, Socket.IO, SQLite stores, file access, Hermes runtime integration. |
| Desktop | `packages/desktop` | Electron shell, local Web UI server bootstrap, updater, bundled Python/Hermes runtime. |
| Tests | `tests` | Vitest unit/integration tests and Playwright browser tests. |
| CI | `.github/workflows` | Build, e2e, lockfile, Docker, and desktop release automation. |

## Request Flow

1. The browser loads the Vite-built client from the Koa server.
2. Client modules call API helpers from `packages/client/src/api`.
3. Server routes in `packages/server/src/routes` wire HTTP paths to controllers.
4. Controllers validate request concerns and delegate reusable behavior to services.
5. Services own side effects: files, SQLite, Hermes profiles, subprocesses, bridges, and credentials.
6. Long-running chat and group-chat flows use Socket.IO namespaces managed by server services.

Keep each layer narrow. Routes should not grow business logic, and client code
should not duplicate server persistence rules.

## State And Data Ownership

- Web UI state defaults to `~/.hermes-web-ui` through `config.appHome`.
- `HERMES_WEB_UI_HOME` and `HERMES_WEBUI_STATE_DIR` override Web UI state location.
- Hermes Agent state lives under Hermes profile directories and must stay distinct from Web UI state.
- Uploads default to `config.uploadDir`, which is derived from the Web UI home unless `UPLOAD_DIR` is set.
- Runtime data directories must also live under the Web UI home, not beside built `dist` assets.
- Profile-scoped Hermes data should use existing profile helpers instead of manually joining paths.

## Server Structure

- `routes/` registers HTTP and WebSocket entry points.
- `controllers/` handles request-level behavior.
- `services/` owns reusable IO, domain behavior, external process calls, and integration logic.
- `db/` owns SQLite schemas and stores.
- `middleware/` owns request middleware such as user auth.
- `shared/` contains cross-server constants and helpers.

Architecture rules:

- Register local API routes before proxy catch-all routes.
- Keep auth behavior centralized in `packages/server/src/services/auth.ts`.
- Prefer `execFile` or `spawn` with argument arrays over shell command strings.
- Use structured file and YAML/JSON parsers when editing structured data.

## Client Structure

- `views/` contains route-level screens.
- `components/` contains reusable UI.
- `stores/` contains Pinia state.
- `api/` contains HTTP clients and should use `packages/client/src/api/client.ts`.
- `i18n/` contains locale messages for user-facing strings.
- `styles/` contains global styling and theme primitives.

Frontend rules:

- Use Vue 3 Composition API with `<script setup lang="ts">`.
- Use existing Naive UI patterns before adding new UI conventions.
- Add visible text to all locale files.
- Keep component styles scoped unless the style is intentionally global.

## Desktop Release Flow

Desktop packaging is intentionally split:

- Pull requests run the web UI build and tests in `.github/workflows/build.yml`.
- Published GitHub Releases run Web UI artifact packaging and Docker image publishing without
  marking the release as GitHub latest.
- Manual dispatches run full desktop artifact packaging in `.github/workflows/desktop-release.yml`.
- `.github/workflows/desktop-manual-build.yml` builds one desktop target for targeted repairs or re-runs.
- Each release matrix target uploads only the artifact globs for its own platform.
- A successful full desktop release marks the target GitHub Release as latest after all desktop artifacts
  and the merged macOS updater manifest have been uploaded.

Do not make a Windows job require macOS `.dmg` files or a Linux job require
Windows installers. Keep `fail_on_unmatched_files: true` where platform-specific
artifact lists make the expectation explicit.

## Validation Surface

The minimum mechanical harness is:

- `npm run harness:check` for repository docs, workflow, and package-script invariants.
- `npm run test` or focused Vitest tests for local logic.
- `npm run test:e2e` for browser-visible routing/auth/chat regressions.
- `npm run build` for type checking and production bundles.

See `docs/harness/validation.md` for change-specific commands.
