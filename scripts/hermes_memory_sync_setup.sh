#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SYNC_SCRIPT="$SCRIPT_DIR/hermes_memory_sync.sh"
VAULT_PATH="${HERMES_MEMORY_VAULT_PATH:-/Users/kk/Documents/Codex/Hermes-Quant-Workspace/hermes-knowledge/trading-journal}"
REMOTE_NAME="${HERMES_MEMORY_REMOTE_NAME:-origin}"
BRANCH="${HERMES_MEMORY_BRANCH:-main}"
CRON_EXPR="${HERMES_MEMORY_SYNC_CRON:-0 * * * *}"
PM2_NAME="${HERMES_MEMORY_PM2_NAME:-hermes-memory-sync}"
REMOTE_URL="${HERMES_MEMORY_REMOTE_URL:-}"
INSTALL_PM2=0

usage() {
  cat <<USAGE
Usage:
  scripts/hermes_memory_sync_setup.sh [remote-url] [--install-pm2]

Environment:
  HERMES_MEMORY_VAULT_PATH   Default: /Users/kk/Documents/Codex/Hermes-Quant-Workspace/hermes-knowledge/trading-journal
  HERMES_MEMORY_REMOTE_URL   Private Git remote URL
  HERMES_MEMORY_SYNC_CRON    Default: 0 * * * * hourly

Examples:
  HERMES_MEMORY_REMOTE_URL=git@github.com:you/hermes-memory-vault.git scripts/hermes_memory_sync_setup.sh --install-pm2
  scripts/hermes_memory_sync_setup.sh git@github.com:you/hermes-memory-vault.git --install-pm2
USAGE
}

for arg in "$@"; do
  case "$arg" in
    --install-pm2)
      INSTALL_PM2=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      REMOTE_URL="$arg"
      ;;
  esac
done

log() {
  printf '[hermes-memory-setup] %s\n' "$*"
}

if [[ ! -d "$VAULT_PATH" ]]; then
  log "Creating vault path: $VAULT_PATH"
  mkdir -p "$VAULT_PATH"
fi

cd "$VAULT_PATH"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git init
fi

git branch -M "$BRANCH"
git config user.name "Hermes Memory Sync"
git config user.email "hermes-memory-sync@local"

if [[ ! -f .gitignore ]]; then
  cat > .gitignore <<'GITIGNORE'
.DS_Store
.env
*.key
*.token
raw/secrets/
logs/private/
.openclaw-wiki/cache/private/
GITIGNORE
  log "Created .gitignore"
fi

if [[ -n "$REMOTE_URL" ]]; then
  if git remote get-url "$REMOTE_NAME" >/dev/null 2>&1; then
    git remote set-url "$REMOTE_NAME" "$REMOTE_URL"
  else
    git remote add "$REMOTE_NAME" "$REMOTE_URL"
  fi
  log "Configured remote '$REMOTE_NAME'."
else
  log "No remote URL provided. Local Git protection is ready; cloud push is disabled until remote is set."
fi

chmod +x "$SYNC_SCRIPT"

if [[ "$INSTALL_PM2" -eq 1 ]]; then
  export PATH="/Users/kk/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
  if ! command -v pm2 >/dev/null 2>&1; then
    log "PM2 not found. Install it first with: npm install -g pm2"
    exit 1
  fi

  if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
    pm2 delete "$PM2_NAME"
  fi

  HERMES_MEMORY_VAULT_PATH="$VAULT_PATH" pm2 start "$SYNC_SCRIPT" \
    --name "$PM2_NAME" \
    --cron-restart="$CRON_EXPR" \
    --no-autorestart
  pm2 save
  log "PM2 schedule installed: $PM2_NAME ($CRON_EXPR)"
fi

log "Setup complete."
log "Vault: $VAULT_PATH"
log "Project: $PROJECT_ROOT"
