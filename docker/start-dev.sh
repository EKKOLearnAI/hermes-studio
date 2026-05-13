#!/bin/bash
set -e

# Development startup script - SSH only
# Connect via VSCode Remote-SSH and run npm run dev manually

# Graceful shutdown handler
cleanup() {
    echo "[start-dev] Shutting down..."
    service ssh stop 2>/dev/null || true
    exit 0
}

trap cleanup SIGTERM SIGINT SIGQUIT

# Mark container environment
touch /.dockerenv 2>/dev/null || true

# Force environment variables
export PATH=/opt/hermes/.venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HERMES_HOME=/root/.hermes
export HERMES_BIN=/opt/hermes/.venv/bin/hermes
export HERMES_ALLOW_ROOT_GATEWAY=1

# Ensure .hermes directory exists
echo "[start-dev] Setting up environment..."
mkdir -p /root/.hermes/logs
mkdir -p /root/.hermes-web-ui
mkdir -p /root/workspace

# Generate SSH host keys if not present
ssh-keygen -A 2>/dev/null || true

# Set password
if [ -n "$SSH_PASSWORD" ]; then
    echo "root:$SSH_PASSWORD" | chpasswd
else
    echo "root:hermes" | chpasswd
fi

# Configure authorized_keys if provided
if [ -f /root/.ssh/authorized_keys ]; then
    chmod 600 /root/.ssh/authorized_keys
fi

# Add environment variables to /root/.bashrc for SSH sessions
cat >> /root/.bashrc << 'EOF'
export PATH=/opt/hermes/.venv/bin:$PATH
export HERMES_HOME=/root/.hermes
export HERMES_BIN=/opt/hermes/.venv/bin/hermes
export HERMES_ALLOW_ROOT_GATEWAY=1
export GATEWAY_DEFAULT_HOST=127.0.0.1
EOF

# Start SSH server
echo "[start-dev] Starting SSH server..."
/usr/sbin/sshd -D -p 22 &
SSH_PID=$!

sleep 1
if kill -0 $SSH_PID 2>/dev/null; then
    echo ""
    echo "=========================================="
    echo "  Hermes Web UI Development Container"
    echo "=========================================="
    echo ""
    echo "  SSH: ssh root@localhost -p 2222"
    echo "  Password: ${SSH_PASSWORD:-hermes}"
    echo ""
    echo "  After connecting, run:"
    echo "    cd /app"
    echo "    npm run dev"
    echo ""
    echo "=========================================="
    echo ""
else
    echo "[start-dev] ERROR: SSH server failed to start"
    exit 1
fi

# Keep container running
wait $SSH_PID
