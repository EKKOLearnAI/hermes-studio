# Docker Compose Guide

This repository ships two Docker Compose configurations: production and development.

## Production

```bash
# Build and start
docker compose up -d --build

# View logs
docker compose logs -f
```

Open: `http://localhost:6060`

## Development (VSCode Remote-SSH)

```bash
# Build and start development container
docker compose -f docker-compose.dev.yml up -d --build
```

### Connect via VSCode

1. Install **Remote - SSH** extension
2. Press `F1` → `Remote-SSH: Connect to Host...`
3. Enter: `ssh root@localhost -p 2222`
4. Password: `hermes` (or custom via `SSH_PASSWORD`)
5. Open folder: `/app`

### Start Development

After connecting, open terminal in VSCode and run:

```bash
cd /app
npm run dev
```

This starts both frontend (Vite) and backend (nodemon) with hot-reload.

## Environment Variables

### Production

| Variable | Default | Description |
|---|---|---|
| `PORT` | `6060` | Web UI port |
| `HERMES_DATA_DIR` | `./hermes_data` | Data directory |
| `AUTH_DISABLED` | `false` | Disable authentication |

### Development

| Variable | Default | Description |
|---|---|---|
| `SSH_PORT` | `2222` | SSH port (host side) |
| `SSH_PASSWORD` | `hermes` | SSH password |
| `HERMES_DATA_DIR` | `./hermes_data` | Data directory |

## Ports

### Production

| Port | Description |
|---|---|
| 6060 | Web UI |
| 8642-8670 | Gateway ports |

### Development

| Port | Description |
|---|---|
| 2222 | SSH (connect via VSCode) |
| 6060 | Web UI |
| 8642-8670 | Gateway ports |

## Common Commands

```bash
# Production
docker compose up -d
docker compose down
docker compose logs -f

# Development
docker compose -f docker-compose.dev.yml up -d --build
docker compose -f docker-compose.dev.yml down
docker compose -f docker-compose.dev.yml logs -f

# Access container shell
docker exec -it hermes-webui-dev bash
```
