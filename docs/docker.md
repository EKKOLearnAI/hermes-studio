# Docker Compose Guide

This repository ships an environment-variable driven Docker Compose setup with two modes: production and development.

## Quick Start

### Production Mode

```bash
# Use pre-built image (Recommended)
WEBUI_IMAGE=ekkoye8888/hermes-web-ui docker compose up -d

# Or build from source
docker compose up -d --build

docker compose logs -f hermes-webui
```

Open: `http://localhost:6060`

### Development Mode (with SSH)

```bash
# Build and start development container
docker compose -f docker-compose.dev.yml up -d --build

docker compose -f docker-compose.dev.yml logs -f hermes-webui-dev
```

Open: `http://localhost:6060`

## Services

### Production Container (`hermes-webui`)
- Single-container deployment with integrated Hermes Agent
- Optimized for production use
- No SSH access

### Development Container (`hermes-webui-dev`)
- Full development environment with SSH access
- VSCode Remote-SSH support
- Source code mounted for live editing
- Debug port exposed (9229)
- Hot-reload support

## VSCode Remote-SSH Setup

### 1. Start Development Container

```bash
docker compose -f docker-compose.dev.yml up -d --build
```

### 2. Connect via VSCode

1. Install the **Remote - SSH** extension in VSCode
2. Press `F1` and select `Remote-SSH: Connect to Host...`
3. Enter: `root@localhost` (or custom SSH port: `root@localhost:22`)
4. Enter password: `hermes` (or custom password via `SSH_PASSWORD` env)
5. Open folder: `/app`

### 3. Configure SSH Key Authentication (Optional)

To avoid entering password each time:

```bash
# Copy your public key to the container
docker cp ~/.ssh/id_rsa.pub hermes-webui-dev:/root/.ssh/authorized_keys

# Or mount it in docker-compose.dev.yml
# volumes:
#   - ~/.ssh/id_rsa.pub:/root/.ssh/authorized_keys:ro
```

### 4. Debug Configuration

Create `.vscode/launch.json` in the opened `/app` folder:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "attach",
      "name": "Attach to Server",
      "port": 9229,
      "restart": true,
      "remoteRoot": "/app",
      "localRoot": "${workspaceFolder}"
    }
  ]
}
```

To enable debug mode:

```bash
DEBUG=true docker compose -f docker-compose.dev.yml up -d
```

## Environment Variables

### Common Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `6060` | Web UI listen port |
| `HERMES_AGENT_IMAGE` | `nousresearch/hermes-agent:latest` | Hermes Agent base image |
| `HERMES_DATA_DIR` | `./hermes_data` | Hermes runtime data directory |
| `AUTH_DISABLED` | `false` | Set to `true` to disable login authentication |
| `GATEWAY_DEFAULT_HOST` | `127.0.0.1` | Default gateway host |

### Production Variables

| Variable | Default | Description |
|---|---|---|
| `WEBUI_IMAGE` | `hermes-web-ui-local:latest` | Web UI image |
| `WEBUI_CONTAINER_NAME` | `hermes-webui` | Container name |

### Development Variables

| Variable | Default | Description |
|---|---|---|
| `DEV_IMAGE` | `hermes-web-ui-dev:latest` | Development image |
| `DEV_CONTAINER_NAME` | `hermes-webui-dev` | Container name |
| `SSH_PORT` | `22` | SSH listen port |
| `SSH_PASSWORD` | `hermes` | SSH root password |
| `DEBUG` | `false` | Enable Node.js debug mode |

## Data Persistence

| Path | Description |
|---|---|
| `${HERMES_DATA_DIR}` (`./hermes_data`) | Hermes runtime data (sessions, config, profiles) |
| `${HERMES_DATA_DIR}/hermes-web-ui` | Web UI data (auth token, etc.) |
| `${HERMES_DATA_DIR}/workspace` | Hermes workspace directory |

- Hermes data persists in `./hermes_data`, mapped to `/home/agent/.hermes` in the container.
- Web UI data persists in `./hermes_data/hermes-web-ui/`, mapped to `/home/agent/.hermes-web-ui` in the container.
- Workspace persists in `./hermes_data/workspace/`, mapped to `/home/agent/workspace` in the container.
- When `AUTH_DISABLED=false`, the auth token is auto-generated on first run and printed to container logs.

## Port Mapping

### Production

| Port | Description |
|---|---|
| `${PORT}` (6060) | Web UI dashboard |
| `8642-8670` | Hermes Agent gateway ports |

### Development

| Port | Description |
|---|---|
| `${PORT}` (6060) | Web UI dashboard |
| `${SSH_PORT}` (22) | SSH server |
| `8642-8670` | Hermes Agent gateway ports |
| `9229` | Node.js debug port |

## Development Workflow

### 1. Start Development Container

```bash
docker compose -f docker-compose.dev.yml up -d --build
```

### 2. Connect via VSCode Remote-SSH

```bash
# In VSCode: Remote-SSH: Connect to Host
ssh root@localhost
# Open folder: /app
```

### 3. Edit Code

- Source code is mounted from host to `/app` in container
- Changes on host are reflected in container immediately
- Run `npm run dev` in container terminal for hot-reload

### 4. Debug

```bash
# Start with debug mode
DEBUG=true docker compose -f docker-compose.dev.yml up -d

# In VSCode, use "Attach to Server" configuration
# Set breakpoints and debug
```

### 5. View Logs

```bash
docker compose -f docker-compose.dev.yml logs -f hermes-webui-dev
```

## Common Operations

### Production

```bash
# Start
docker compose up -d

# Stop
docker compose down

# Rebuild
docker compose up -d --build

# View logs
docker compose logs -f

# View auth token
docker compose logs hermes-webui | grep token
```

### Development

```bash
# Start
docker compose -f docker-compose.dev.yml up -d

# Stop
docker compose -f docker-compose.dev.yml down

# Rebuild
docker compose -f docker-compose.dev.yml up -d --build

# View logs
docker compose -f docker-compose.dev.yml logs -f

# Access container shell
docker exec -it hermes-webui-dev bash

# Run tests in container
docker exec -it hermes-webui-dev npm test
```

## Container Configuration

Both containers run as `root` for simplicity and compatibility.

Key configurations:
- `HOME=/home/agent` - User home directory
- `HERMES_HOME=/home/agent/.hermes` - Hermes configuration directory
- `HERMES_BIN=/opt/hermes/.venv/bin/hermes` - Hermes CLI binary path
- Volume mounts use `:z` suffix for SELinux compatibility (Podman)

## Troubleshooting

### SSH Connection Refused

```bash
# Check if SSH is running
docker exec -it hermes-webui-dev ps aux | grep sshd

# Check SSH logs
docker exec -it hermes-webui-dev cat /var/log/auth.log
```

### VSCode Remote-SSH Slow

VSCode downloads and installs the server on first connection. This is normal.

To speed up subsequent connections:
1. Keep the container running
2. Use SSH key authentication
3. Pre-install VSCode server (see Dockerfile.dev)

### Debug Port Not Working

```bash
# Check if debug mode is enabled
docker exec -it hermes-webui-dev env | grep DEBUG

# Restart with debug mode
DEBUG=true docker compose -f docker-compose.dev.yml up -d
```

### Permission Issues

```bash
# Fix file permissions
docker exec -it hermes-webui-dev chown -R root:root /app
```
