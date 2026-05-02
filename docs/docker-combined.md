# Combined Hermes Container

将webui和agent容器合二为一，对于容器文件权限做处理，兼容SELinux和podman

## Quick Start

### Build and Run

```bash
# Copy environment configuration
cp .env.combined.example .env

# Edit .env if needed (optional)
# vim .env

# Build and start (using podman-compose)
podman-compose -f docker-compose.combined.yml up -d --build

# View logs
podman-compose -f docker-compose.combined.yml logs -f

# Stop
podman-compose -f docker-compose.combined.yml down
```

### Using Docker

```bash
# Build and start (using docker compose)
docker compose -f docker-compose.combined.yml up -d --build

# View logs
docker compose -f docker-compose.combined.yml logs -f

# Stop
docker compose -f docker-compose.combined.yml down
```

## Access

- **Web UI:** http://localhost:6060
- **Auth Token:** Check logs or `./hermes_data/hermes-web-ui/.token`

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HERMES_AGENT_IMAGE` | `nousresearch/hermes-agent:latest` | Base hermes-agent image |
| `COMBINED_IMAGE` | `hermes-combined:latest` | Combined image name |
| `CONTAINER_NAME` | `hermes` | Container name |
| `HERMES_DATA_DIR` | `./hermes_data` | Host path for data persistence |
| `PORT` | `6060` | Web UI port |
| `AUTH_DISABLED` | `false` | Set to `true` to disable authentication |

### Restart Services

```bash
podman-compose -f docker-compose.combined.yml restart
```

### Rebuild from Scratch

```bash
podman-compose -f docker-compose.combined.yml down
podman-compose -f docker-compose.combined.yml up -d --build
```

### Check Container Health

```bash
# Check if both services are running
podman-compose -f docker-compose.combined.yml ps

# Check hermes-agent default gateway health
curl http://localhost:8642/health

# Check hermes-webui health
curl http://localhost:6060/health
```
