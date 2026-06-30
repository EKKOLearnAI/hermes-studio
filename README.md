<p align="center">
  <strong>Hermes Studio</strong>
  <a href="./README_zh.md">中文</a>
</p>

<p align="center">
  A desktop app, local runtime, and web console for <a href="https://github.com/NousResearch/hermes-agent">Hermes Agent</a>.<br/>
  Chat with agents, manage models and profiles, connect platform channels,<br/>
  automate jobs, inspect files, run coding agents, and keep everything local.
</p>

<p align="center">
  <a href="https://github.com/EKKOLearnAI/hermes-studio/releases/latest">Download Hermes Studio Desktop</a>
  ·
  <code>npm install -g hermes-web-ui && hermes-web-ui start</code>
</p>

<p align="center">
  <img src="https://github.com/EKKOLearnAI/hermes-studio/blob/main/packages/client/src/assets/image.gif" alt="Hermes Web UI Demo" width="680"/>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/hermes-web-ui"><img src="https://img.shields.io/npm/v/hermes-web-ui?style=flat-square&color=blue" alt="npm version"/></a>
  <a href="https://github.com/EKKOLearnAI/hermes-studio/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/hermes-web-ui?style=flat-square" alt="license"/></a>
  <a href="https://github.com/EKKOLearnAI/hermes-studio/stargazers"><img src="https://img.shields.io/github/stars/EKKOLearnAI/hermes-studio?style=flat-square" alt="stars"/></a>
</p>

## Core Capabilities

| Area | What Hermes Studio does |
| --- | --- |
| Agent chat | Runs Hermes Agent conversations with streaming responses, tool traces, file upload/download, and persistent local sessions. |
| Local control plane | Manages profiles, providers, models, credentials, memory, skills, plugins, logs, and runtime settings from one dashboard. |
| Automation | Configures platform channels, cron jobs, Kanban tasks, group-chat rooms, and MCP servers around the same Hermes profiles. |
| Workspace tools | Provides a file browser, web terminal, voice input/output, coding-agent runners, device discovery, and performance views. |
| Distribution | Ships as a desktop app for Windows/macOS/Linux, an npm CLI package, and a Docker image. |

## Features

### AI Chat

- Real-time chat streaming over Socket.IO `/chat-run`; chat runs execute through the Hermes agent bridge
- Multi-session management — create, rename, delete, switch between sessions
- **Self-built session database** — local SQLite storage for Web UI sessions; Hermes state.db remains a read-only source for Hermes history APIs
- Session grouping by source (Telegram, Discord, Slack, etc.) with collapsible accordion
- Active session indicator — live sessions pin to top with spinner icon
- Sessions sorted by latest message time
- Markdown rendering with syntax highlighting and code copy
- Tool call detail expansion (arguments / result)
- Profile-scoped file uploads
- File download support — download uploaded files and agent-generated files by resolved path across local, Docker, SSH, and Singularity backends
- Session search — Ctrl+K search across the Web UI local session database; read-only Hermes history sessions are not included
- Profile-aware model selector — discovers models available to the signed-in account through authorized Hermes profiles
- Per-session model display badge and context token usage

### Platform Channels

Unified configuration for **8 platforms** in one page:

| Platform      | Features                                                               |
| ------------- | ---------------------------------------------------------------------- |
| Telegram      | Bot token, mention control, reactions, free-response chats             |
| Discord       | Bot token, mention, auto-thread, reactions, channel allow/ignore lists |
| Slack         | Bot token, mention control, bot message handling                       |
| WhatsApp      | Enable/disable, mention control, mention patterns                      |
| Matrix        | Access token, homeserver, auto-thread, DM mention threads              |
| Feishu (Lark) | App ID / Secret, mention control                                       |
| WeChat        | QR code login (scan in browser, auto-save credentials)                 |
| WeCom         | Bot ID / Secret                                                        |

- Credential management writes to `~/.hermes/.env`
- Channel behavior settings write to `~/.hermes/config.yaml`
- Per-platform configured/unconfigured status detection

### Usage Analytics

- Total token usage breakdown (input / output)
- Session count with daily average
- Estimated cost tracking & cache hit rate
- Model usage distribution chart
- 30-day daily trend (bar chart + data table)

### Scheduled Jobs

- Create, edit, pause, resume, delete cron jobs
- Trigger immediate execution
- Cron expression quick presets

### Kanban

- Profile-aware Kanban board for planning and tracking agent work
- Task creation, updates, and status movement from the dashboard
- Shared with the same local Web UI state and authentication model

### Model Management

- Auto-discover models from credential pool (`~/.hermes/auth.json`)
- Fetch available models from each provider endpoint (`/v1/models`)
- Add, update, and delete providers (preset & custom OpenAI-compatible)
- OpenAI Codex & Nous Portal OAuth login
- Provider URL auto-detection for non-v1 API versions (e.g. `/v4`)
- Provider-level model grouping with default model switching

### Multi-Profile

- Create, rename, delete, and switch between Hermes profiles
- Clone existing profile or import from archive (`.tar.gz`)
- Export profile for backup or sharing
- Profile-scoped configuration, cache, uploads, sessions, jobs, usage, memory, skills, plugins, providers, and model visibility
- Account-bound profile access: super administrators can manage every profile; regular administrators only see and use profiles assigned to their account

### File Browser

- Browse files on remote backends (local, Docker, SSH, Singularity)
- Upload, download, rename, copy, move, and delete files
- Store uploaded files under the selected/requested Hermes profile while keeping downloads path-based for agent-generated artifacts outside the upload directory
- Create directories
- View file content with syntax highlighting

### Group Chat

- Multi-agent chat rooms with real-time messaging via Socket.IO
- @mention routing — mention an agent to trigger a contextual reply
- Context compression — automatic conversation summarization when history exceeds token threshold
- Typing status and reply progress indicators
- Room creation, deletion, and invite code management
- Agent management — add/remove agents from rooms with per-agent profiles
- SQLite message persistence
- Mobile responsive with collapsible sidebar

### Coding Agents

- Launch and monitor local coding-agent sessions from the web dashboard
- Dedicated proxy routes for Codex and Claude Code integrations
- Stores agent output and reasoning metadata for later inspection

### Skills & Memory

- Browse and search installed skills
- View skill details and attached files
- User notes and profile management

### Logs

- View agent / server / error logs
- Filter by log level, log file, and keyword
- Structured log parsing with HTTP access log highlighting

### Admin & Runtime Management

- Device and LAN peer views for local-network discovery and peer tooling
- MCP manager for the managed `hermes-studio` MCP server and profile injection
- Runtime version and version-preview tooling for testing newer builds in isolation
- Performance monitor views for super administrators

### Authentication

- Token-based auth (auto-generated on first run or set via `AUTH_TOKEN` env var)
- Username/password login with account management in Settings
- Default bootstrap credentials are `admin` / `123456`; users are prompted after login to change the default username and password
- Super administrators can manage users and profile bindings; regular administrators can manage their own account details

CLI maintenance commands:

```bash
# Delete persisted login IP lock records
hermes-web-ui clear-login-locks

# Delete login locks and restart the running Web UI process
hermes-web-ui clear-login-locks --restart

# Create or reset the default super administrator login to admin / 123456
hermes-web-ui reset-default-login
```

`clear-login-locks` removes `${HERMES_WEB_UI_HOME:-~/.hermes-web-ui}/.login-lock.json`. If the server is running, restart it to clear in-memory lock state. `reset-default-login` updates the Web UI account database; if an `admin` user already exists, its password is reset to `123456` and the account is enabled as a super administrator.

### Settings

- Display (streaming, compact mode, reasoning, cost display)
- Agent (max turns, timeout, tool enforcement)
- Memory (enable/disable, char limits)
- Session reset (idle timeout, scheduled reset)
- Privacy (PII redaction)
- Model settings (default model & provider)
- Profile and provider configuration

### Voice / TTS / STT

- Read assistant replies aloud from chat and group-chat messages.
- Providers: browser Web Speech, built-in Edge TTS, OpenAI-compatible `/audio/speech`, custom OpenAI-compatible TTS endpoints, and MiMo.
- MiMo supports preset voices, voice design prompts, and voice clone reference audio (`.mp3`/`.wav`, max 10 MB) with selectable auth header mode (`Authorization`, `api-key`, or both).
- Edge/OpenAI-compatible/custom/MiMo playback uses the Web UI backend's unified `/api/hermes/tts/synthesize` endpoint, so stop/pause state is shared and in-flight fetches are aborted when possible.
- Provider API keys and MiMo clone reference audio are saved in server-side TTS settings, with only masked secret status shown back to the browser.
- Save provider settings in Settings → Voice before using OpenAI/custom/MiMo playback. Message playback sends text and non-secret playback options; the backend reads the stored per-user secret when synthesizing.
- Turn-based voice input is available from the chat input mic control: start/stop a voice turn, transcribe it, stage the transcript in the current input box for editing, then send it with the normal Send button.
- Voice input / STT can use browser speech recognition when available or a server-backed provider configured in Settings → Voice.
- Starting a new voice turn while assistant audio is playing stops playback first. This barge-in boundary does not implicitly cancel an active agent run; stopping a run remains an explicit action.
- For supported settings, security notes, and current non-goals, see [`docs/voice-dialogue.md`](./docs/voice-dialogue.md).
- Limitation: external TTS providers may continue processing a request after the browser/server aborts; custom/OpenAI-compatible and MiMo base URLs must be public `http`/`https` endpoints and cannot target localhost/private networks.

### Web Terminal

- Integrated terminal powered by node-pty and @xterm/xterm
- Multi-session support — create, switch between, and close terminal sessions
- Real-time keyboard input and PTY output streaming via WebSocket
- Window resize support

### Desktop App & Updates

- Native Electron shell for Windows, macOS, and Linux
- Bundles the Web UI runtime and starts the local Hermes Studio server automatically
- Uses Cloudflare download endpoints for desktop auto-update metadata and assets first
- Falls back to GitHub Releases `latest` assets if the Cloudflare update feed is unavailable
- Windows upgrades attempt to close an existing Hermes Studio process before replacing files

---

## Quick Start

### Desktop App (Recommended)

Download the latest **Hermes Studio** desktop installer from
[GitHub Releases](https://github.com/EKKOLearnAI/hermes-studio/releases/latest).

Desktop builds are published for macOS, Windows, and Linux, with separate
architecture assets where applicable. The desktop app bundles the Web UI
runtime and stores Hermes Agent data in the native Hermes location:

- Windows: `%LOCALAPPDATA%\hermes` (falls back to `%APPDATA%\hermes`)
- macOS/Linux: `~/.hermes`

The desktop wrapper stores its own Web UI state separately in
`~/.hermes-web-ui` unless `HERMES_WEB_UI_HOME` is set.

After the packaged desktop app starts, it installs managed command shims so the
desktop app, bundled Hermes Agent CLI, and bundled Web UI CLI do not conflict:

| Command | Description |
| --- | --- |
| `hermes-studio` | Open the Hermes Studio desktop app |
| `hermes-studio cli ...` | Run the bundled Hermes Agent CLI |
| `hermes-studio web ...` | Run the bundled `hermes-web-ui` command |
| `hermes-studio -h` | Show wrapper help |
| `hermes-studio-mcp` | Run the managed Web UI MCP bridge |

Use `hermes-studio cli -h` for Hermes Agent CLI help and
`hermes-studio web -h` for Web UI CLI help.

Desktop auto-updates read the latest feed from
`https://download.ekkolearnai.com/latest` first. If that endpoint is
unavailable, the updater falls back to
`https://github.com/EKKOLearnAI/hermes-studio/releases/latest/download`.

### npm

```bash
npm install -g hermes-web-ui
hermes-web-ui start
```

Open **http://localhost:8648**

### Docker Compose

Single-container deployment with integrated Hermes Agent:

```bash
# Use pre-built image (Recommended)
WEBUI_IMAGE=ekkoye8888/hermes-web-ui docker compose up -d

# Or build from source
docker compose up -d --build

docker compose logs -f hermes-webui
```

Open **http://localhost:6060**

- Persistent Hermes data is stored in `./hermes_data`
- Web UI auth token is stored in `./hermes_data/hermes-web-ui/.token`
- On first run with auth enabled, the token is printed to container logs
- All runtime settings are environment-variable driven in `docker-compose.yml`

For detailed notes and troubleshooting, see [`docs/docker.md`](./docs/docker.md).

### Hermes Agent Runtime Discovery

When Web UI starts backend chat features, it prefers a source checkout that
contains `run_agent.py` such as `~/.hermes/hermes-agent`. If no source checkout
is found, it falls back to the Python environment used by the installed
`hermes` command, then the system Python. This supports both source installs
and package installs such as `pip install hermes-agent`.

## Web UI Environment Variables

These variables configure Hermes Web UI, its local Hermes runtime integration, and development/preview helpers. Provider API keys and Hermes Agent settings are normally managed through Hermes profiles; environment variables here are process-level overrides.

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8648` | Web UI listen port. |
| `BIND_HOST` | `0.0.0.0` | Web UI bind host. Set `::` explicitly for IPv6. |
| `HERMES_WEB_UI_HOME` | `~/.hermes-web-ui` | Web UI data home for auth token, credentials, logs, DB, and default uploads. `HERMES_WEBUI_STATE_DIR` is also supported as a compatibility alias. |
| `HERMES_WEBUI_STATE_DIR` | unset | Compatibility alias for `HERMES_WEB_UI_HOME`. |
| `HERMES_WEB_UI_DISABLE_MCP_AUTOINJECT` | unset | Disable startup injection of the managed `hermes-studio` MCP server into Hermes profile configs. |
| `HERMES_WEB_UI_ALLOW_TRANSIENT_MCP_AUTOINJECT` | unset | Allow managed MCP injection when `HERMES_WEB_UI_HOME` is under a temporary directory, such as Version Preview runtimes. |
| `UPLOAD_DIR` | `$HERMES_WEB_UI_HOME/upload` | Upload root override. Files are stored below profile-scoped subdirectories. |
| `CORS_ORIGINS` | same host only | Comma- or space-separated cross-origin allowlist for HTTP, Socket.IO, and WebSocket requests. Set `*` only when you intentionally need legacy wildcard CORS. |
| `AUTH_TOKEN` | auto-generated | Explicit bearer token. If unset, Web UI creates one under `HERMES_WEB_UI_HOME`. |
| `AUTH_JWT_SECRET` | `AUTH_TOKEN` | JWT signing secret override for username/password sessions. |
| `HERMES_WEB_UI_AUTH_JWT_EXPIRES_IN` | `30d` | Username/password session JWT lifetime. Accepts seconds or `s`/`m`/`h`/`d` suffixes, for example `12h` or `7d`. |
| `PROFILE` | `default` | Startup/default Hermes profile. Runtime requests use the profile selected by the frontend and authorized for the current account. |
| `LOG_LEVEL` | `info` | Server log level. |
| `BRIDGE_LOG_LEVEL` | `$LOG_LEVEL` or `info` | Bridge log level. |
| `MAX_DOWNLOAD_SIZE` | `200MB` | Maximum file download size. |
| `MAX_EDIT_SIZE` | `10MB` | Maximum editable file size. |
| `WORKSPACE_BASE` | current user's home directory | Base directory for workspace browsing. |
| `HERMES_HOME` | platform default | Hermes data home. Windows uses `%LOCALAPPDATA%\hermes`; macOS/Linux uses `~/.hermes`. |
| `HERMES_BIN` | `hermes` | Custom Hermes CLI binary path. |
| `HERMES_AGENT_ROOT` | auto-discovered | Hermes Agent source checkout containing `run_agent.py`. |
| `HERMES_AGENT_BRIDGE_PYTHON` | auto-discovered | Python interpreter used to launch the agent bridge. |
| `HERMES_AGENT_BRIDGE_UV` | auto-discovered | `uv` executable used to launch the agent bridge when available. |
| `UV` | auto-discovered | Fallback `uv` executable path. |
| `PYTHON` | auto-discovered | Fallback Python executable for the agent bridge. |
| `HERMES_AGENT_BRIDGE_ENDPOINT` | platform default | Agent bridge broker endpoint. Windows defaults to `tcp://127.0.0.1:18765`; macOS/Linux defaults to `ipc:///tmp/hermes-agent-bridge.sock`. |
| `HERMES_AGENT_BRIDGE_TIMEOUT_MS` | `120000` | Timeout for Node requests to the bridge broker. |
| `HERMES_AGENT_BRIDGE_CONNECT_RETRY_MS` | `5000` | Short retry window for connecting to the bridge socket. |
| `HERMES_AGENT_BRIDGE_STARTUP_TIMEOUT_MS` | `120000` | Timeout while waiting for the Python bridge to become ready. |
| `HERMES_AGENT_BRIDGE_STOP_ON_SHUTDOWN` | enabled | Stop the bridge broker during Web UI shutdown and restart. Set `0`, `false`, `no`, or `off` to keep the bridge across restarts. |
| `HERMES_AGENT_BRIDGE_AUTO_RESTART` | enabled | Auto-restart the bridge broker after unexpected exit. Set `0`, `false`, `no`, or `off` to disable. |
| `HERMES_AGENT_BRIDGE_RESTART_DELAY_MS` | `1000` | Base delay for bridge auto-restart backoff. |
| `HERMES_AGENT_BRIDGE_PLATFORM` | `cli` | Platform identity passed to Hermes Agent. |
| `HERMES_AGENT_BRIDGE_WORKER_TRANSPORT` | platform default | Profile worker transport. Set `tcp` for loopback TCP or `ipc`/`unix` for Unix domain sockets; defaults to Windows TCP and macOS/Linux IPC. |
| `HERMES_AGENT_BRIDGE_WORKER_PORT_BASE` | `18780` | Base port for TCP worker endpoints. |
| `HERMES_BRIDGE_PROVIDER` | profile/default | Provider override for bridge runs. |
| `HERMES_BRIDGE_TOOLSETS` | profile/default | Toolset override for bridge runs. |
| `HERMES_BRIDGE_MAX_TURNS` | profile/default | Maximum turn override for bridge runs. |
| `HERMES_BRIDGE_SUPPRESS_PLATFORM_HINT` | `cli` | Controls bridge platform hint suppression passed to Hermes Agent. |
| `HERMES_OPENROUTER_APP_REFERER` | `https://hermes-studio.ai` | OpenRouter attribution referer sent by bridge runs. |
| `HERMES_OPENROUTER_APP_TITLE` | `Hermes Web UI` | OpenRouter attribution title sent by bridge runs. |
| `HERMES_OPENROUTER_APP_CATEGORIES` | `cli-agent,personal-agent` | OpenRouter attribution categories sent by bridge runs. |
| `HERMES_WEB_UI_MANAGED_GATEWAY` | enabled | Controls Web UI-managed Hermes gateway process handling. Set `0`, `false`, `no`, or `off` to use `hermes gateway start` instead. |
| `HERMES_WEB_UI_DISABLE_GATEWAY_AUTOSTART` | unset | Skip startup gateway checks/autostart. Set `1`, `true`, `yes`, or `on` for dashboard-only deployments where another service owns Hermes gateway lifecycle. |
| `HERMES_WEB_UI_DISABLE_SKILL_INJECTION` | unset | Skip startup bundled skill injection. Set `1`, `true`, `yes`, or `on` when bundled skills are managed outside Hermes Web UI. When injection is enabled, Web UI updates only skills it previously installed or identical existing bundled copies; local edits and user-owned same-name skills are skipped. |
| `HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN` | enabled in production | Controls whether Web UI shutdown also stops managed gateway processes. Set `0` or `false` to detach them. |
| `HERMES_GATEWAY_URL` / `GATEWAY_URL` | unset | Explicit Hermes gateway upstream URL for proxy routes. |
| `GATEWAY_HOST` | `127.0.0.1` | Default Hermes gateway upstream host for proxy routes. |
| `GATEWAY_PORT` | `8642` | Default Hermes gateway upstream port for proxy routes. |
| `HERMES_WEB_UI_PREVIEW_REPO` | package repository | GitHub repository used by Version Preview. |
| `HERMES_WEB_UI_PREVIEW_AGENT_BRIDGE_TRANSPORT` | platform default | Version Preview broker transport. Set `tcp` to use loopback TCP for Preview on macOS/Linux; when unset, Preview follows `HERMES_AGENT_BRIDGE_WORKER_TRANSPORT=tcp`. |
| `HERMES_WEB_UI_PREVIEW_AGENT_BRIDGE_ENDPOINT` | isolated preview endpoint | Directly overrides the Version Preview broker endpoint. |
| `HERMES_WEB_UI_BACKEND_PORT` | `8648` | Backend port used by the Vite dev proxy. |
| `HERMES_WEB_UI_FRONTEND_PORT` | `8649` | Frontend Vite dev server port. |

### CLI Commands

| Command                           | Description                        |
| --------------------------------- | ---------------------------------- |
| `hermes-web-ui start`             | Start in background (daemon mode)  |
| `hermes-web-ui start --port 9000` | Start on custom port               |
| `hermes-web-ui stop`              | Stop background process            |
| `hermes-web-ui restart`           | Restart background process; stops the bridge by default |
| `hermes-web-ui status`            | Check if running                   |
| `hermes-web-ui update`            | Update to latest version & restart |
| `hermes-web-ui upgrade`           | Alias for `update`                 |
| `hermes-web-ui -v`                | Show version number                |
| `hermes-web-ui -h`                | Show help message                  |

`restart`, `update`, and `upgrade` stop the Agent Bridge broker by default so restarted or updated servers do not reuse stale Python bridge processes. Set `HERMES_AGENT_BRIDGE_STOP_ON_SHUTDOWN=0` before restarting only when you explicitly want to keep the bridge broker and running bridge sessions alive.

`update` / `upgrade` first attempt `npm cache clean --force`, then run `npm install -g hermes-web-ui@latest` and restart. Cache cleanup is best-effort; if it fails, the updater continues with the install.

### Auto Configuration

On startup the BFF server automatically:

- Initializes Web UI data directories, local databases, and bundled skills
- Starts the Hermes agent bridge used by `/chat-run`
- Opens browser on successful startup

---

## Development

```bash
git clone https://github.com/EKKOLearnAI/hermes-studio.git
cd hermes-web-ui
npm install
npm run dev
```

- Frontend: http://localhost:8649
- BFF Server: http://localhost:8647

```bash
npm run build   # outputs to dist/
```

See [DEVELOPMENT.md](./DEVELOPMENT.md) for project development guidelines.

## Architecture

```
Browser → BFF (Koa, :8648) → Socket.IO /chat-run
                ↓
        Hermes agent bridge → Hermes Agent runtime
                ↓
           Hermes CLI / profiles
           profile config.yaml    (channel/provider behavior)
           profile auth.json      (credential pool)
           Tencent iLink API      (WeChat QR login)
```

The frontend is designed with **multi-agent extensibility** — all Hermes-specific code is namespaced under `hermes/` directories (API, components, views, stores), making it straightforward to add new agent integrations alongside.

The BFF layer handles Socket.IO chat streaming, the Hermes agent bridge, profile-aware file upload and path-based download (multi-backend: local/Docker/SSH/Singularity), session CRUD, account- and profile-scoped management, config/credential management, WeChat QR login, model discovery, skills/memory/plugin management, TTS/STT, coding-agent proxies, MCP/runtime management, log reading, and static file serving.

## Tech Stack

**Frontend:** Vue 3 + TypeScript + Vite + Naive UI + Pinia + Vue Router + vue-i18n + SCSS + markdown-it + highlight.js

**Backend:** Koa 2 (BFF server) + node-pty (web terminal)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=EKKOLearnAI/hermes-studio&type=Date)](https://star-history.com/#EKKOLearnAI/hermes-studio&Date)

<!-- If the chart above doesn't load, visit https://star-history.com/#EKKOLearnAI/hermes-studio -->

## License

[BSL-1.1](./LICENSE)

The license covers Hermes Studio, the former Hermes Web UI name, the
`hermes-web-ui` npm package and CLI, desktop applications, firmware, release
artifacts, documentation, and associated files in this repository.
