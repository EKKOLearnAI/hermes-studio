#!/bin/bash
set -e

# Startup script for hermes-agent + hermes-web-ui
# Runs both services in a single container (as root)
# The web-ui's GatewayManager handles hermes-agent lifecycle

# Graceful shutdown handler (before exec replaces this process)
cleanup() {
    echo "[start] Shutting down..."
    exit 0
}

trap cleanup SIGTERM SIGINT SIGQUIT

# Mark container environment so GatewayManager uses "gateway run" mode
# (Podman doesn't create /.dockerenv like Docker does)
touch /.dockerenv 2>/dev/null || true

# Ensure .hermes directory exists
echo "[start] Ensuring .hermes directory..."
mkdir -p /home/agent/.hermes/logs
mkdir -p /home/agent/.hermes-web-ui

# Ensure workspace directory exists
mkdir -p /home/agent/workspace

# Set hermes default working directory to /home/agent/workspace
echo "[start] Setting hermes cwd to /home/agent/workspace..."
/opt/hermes/.venv/bin/hermes config set messaging.cwd /home/agent/workspace 2>/dev/null || true
/opt/hermes/.venv/bin/hermes config set terminal.cwd /home/agent/workspace 2>/dev/null || true

# Start hermes-webui in foreground (as root, no su)
# The web-ui's GatewayManager will start hermes-agent automatically
echo "[start] Starting hermes-webui on port ${PORT:-6060}..."
cd /app
exec node dist/server/index.js
