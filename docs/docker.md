# Docker Compose Guide

This repository ships an environment-variable driven Docker Compose setup.

## Quick Start

### Pull pre-built image (Recommended)

```bash
WEBUI_IMAGE=ekkoye8888/hermes-web-ui:latest docker compose up -d hermes-agent hermes-webui
docker compose logs -f hermes-webui
```

Open: `http://localhost:6060`

### Build from source

```bash
docker compose up -d --build hermes-agent hermes-webui
docker compose logs -f hermes-webui
```

## Services

This compose file runs two services:

- `hermes-agent` — Hermes Agent runtime (image: `nousresearch/hermes-agent`)
- `hermes-webui` — Web UI dashboard (pre-built image or built from source)

## Environment Variables

All key runtime settings are configured from compose variables.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `6060` | Web UI listen port |
| `BIND_HOST` | `0.0.0.0` | Optional Web UI bind host. Defaults to IPv4 for stable WSL/Windows access. Set `::` explicitly if you want IPv6 listening. |
| `HERMES_BIN` | `/opt/hermes/.venv/bin/hermes` | Path to Hermes CLI binary |
| `HERMES_AGENT_IMAGE` | `nousresearch/hermes-agent:latest` | Hermes Agent base image |
| `WEBUI_IMAGE` | `hermes-web-ui-local:latest` | Web UI image (set to `ekkoye8888/hermes-web-ui:latest` to use pre-built) |
| `HERMES_DATA_DIR` | `./hermes_data` | Hermes runtime data directory |
| `AUTH_DISABLED` | `false` | Set to `true` to disable login authentication |

Override variables directly from shell:

```bash
PORT=16060 \
AUTH_DISABLED=true \
docker compose up -d hermes-agent hermes-webui
```

Or create a `.env` file in the project root:

```
WEBUI_IMAGE=ekkoye8888/hermes-web-ui:latest
PORT=6060
AUTH_DISABLED=false
```

## Data Persistence

| Path | Description |
|---|---|
| `${HERMES_DATA_DIR}` (`./hermes_data`) | Hermes runtime data (sessions, config, profiles) |
| `${HERMES_DATA_DIR}/hermes-web-ui` | Web UI data (auth token, etc.) |

- Hermes data persists in `./hermes_data`, mapped to `/home/agent/.hermes` in the container.
- Web UI data persists in `./hermes_data/hermes-web-ui/`, mapped to `/root/.hermes-web-ui` in the container.
- When `AUTH_DISABLED=false`, the auth token is auto-generated on first run and printed to container logs.
- Deleting the token file and restarting will generate a new one.

## Port Mapping

| Port | Service | Description |
|---|---|---|
| `${PORT}` (6060) | hermes-webui | Web UI dashboard |
| 8642-8670 | hermes-agent | Hermes Agent gateway ports (for multi-profile) |

## Code Runtime Behavior

- Hermes CLI binary comes from `HERMES_BIN` env (`packages/server/src/services/hermes-cli.ts`).
- If `HERMES_BIN` is not provided, code falls back to `hermes` in `PATH`.
- Profile switching dynamically resolves upstream URLs via `GatewayManager`.

## Common Operations

Recreate webui:

```bash
docker compose up -d --no-deps --force-recreate hermes-webui
```

View auth token:

```bash
docker compose logs hermes-webui | grep token
# or
cat ./hermes_data/hermes-web-ui/.token
```

Stop:

```bash
docker compose down
```
