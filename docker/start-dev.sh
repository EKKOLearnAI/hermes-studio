#!/bin/bash
set -e

# Development startup script for hermes-agent + hermes-web-ui
# Supports SSH for VSCode Remote-SSH connection

# Graceful shutdown handler
cleanup() {
    echo "[start-dev] Shutting down..."
    # Stop SSH server
    service ssh stop 2>/dev/null || true
    exit 0
}

trap cleanup SIGTERM SIGINT SIGQUIT

# Mark container environment so GatewayManager uses "gateway run" mode
touch /.dockerenv 2>/dev/null || true

# Ensure .hermes directory exists
echo "[start-dev] Ensuring .hermes directory..."
mkdir -p /home/agent/.hermes/logs
mkdir -p /home/agent/.hermes-web-ui

# Ensure workspace directory exists
mkdir -p /home/agent/workspace

# Set hermes default working directory to /home/agent/workspace
echo "[start-dev] Setting hermes cwd to /home/agent/workspace..."
/opt/hermes/.venv/bin/hermes config set messaging.cwd /home/agent/workspace 2>/dev/null || true
/opt/hermes/.venv/bin/hermes config set terminal.cwd /home/agent/workspace 2>/dev/null || true

# Generate SSH host keys if not present
echo "[start-dev] Configuring SSH server..."
ssh-keygen -A 2>/dev/null || true

# Set default password for root if not set via environment
if [ -n "$SSH_PASSWORD" ]; then
    echo "root:$SSH_PASSWORD" | chpasswd
    echo "[start-dev] SSH password set from environment"
else
    # Default password: hermes
    echo "root:hermes" | chpasswd
    echo "[start-dev] SSH password set to default: hermes"
fi

# Configure authorized_keys if provided
if [ -f /root/.ssh/authorized_keys ]; then
    chmod 600 /root/.ssh/authorized_keys
    echo "[start-dev] Authorized keys configured"
fi

# Start SSH server
echo "[start-dev] Starting SSH server on port ${SSH_PORT:-22}..."
/usr/sbin/sshd -D -p ${SSH_PORT:-22} &
SSH_PID=$!

# Wait for SSH to start
sleep 1
if kill -0 $SSH_PID 2>/dev/null; then
    echo "[start-dev] SSH server started successfully"
    echo "[start-dev] Connect via: ssh root@localhost -p ${SSH_PORT:-22}"
else
    echo "[start-dev] WARNING: SSH server failed to start"
fi

# Install VSCode server dependencies (if not already installed)
echo "[start-dev] Checking VSCode server dependencies..."
if [ ! -d "$HOME/.vscode-server" ]; then
    mkdir -p "$HOME/.vscode-server"
    echo "[start-dev] VSCode server directory created"
fi

# Start hermes-webui in foreground
echo "[start-dev] Starting hermes-webui on port ${PORT:-6060}..."
echo "[start-dev] Debug port available on 9229"
echo ""
echo "=========================================="
echo "  Hermes Web UI Development Container"
echo "=========================================="
echo ""
echo "  Web UI:    http://localhost:${PORT:-6060}"
echo "  SSH:       ssh root@localhost -p ${SSH_PORT:-22}"
echo "  Debug:     localhost:9229"
echo "  Workspace: /home/agent/workspace"
echo ""
echo "  VSCode Remote-SSH connection:"
echo "    1. Install 'Remote - SSH' extension"
echo "    2. Connect to: root@localhost:${SSH_PORT:-22}"
echo "    3. Open folder: /app"
echo ""
echo "=========================================="
echo ""

cd /app

# Start with debug port if DEBUG mode is enabled
if [ "$DEBUG" = "true" ]; then
    exec node --inspect=0.0.0.0:9229 dist/server/index.js
else
    exec node dist/server/index.js
fi
