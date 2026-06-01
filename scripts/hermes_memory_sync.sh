#!/usr/bin/env bash
set -euo pipefail

VAULT_PATH="${HERMES_MEMORY_VAULT_PATH:-/Users/kk/Documents/Codex/Hermes-Quant-Workspace/hermes-knowledge/trading-journal}"
REMOTE_NAME="${HERMES_MEMORY_REMOTE_NAME:-origin}"
BRANCH="${HERMES_MEMORY_BRANCH:-main}"
COMMIT_PREFIX="${HERMES_MEMORY_COMMIT_PREFIX:-Hermes Memory Sync}"

log() {
  printf '[hermes-memory-sync] %s\n' "$*"
}

fail_soft() {
  log "$*"
  exit 0
}

if [[ ! -d "$VAULT_PATH" ]]; then
  fail_soft "Vault path not found: $VAULT_PATH"
fi

cd "$VAULT_PATH"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  fail_soft "Git is not initialized. Run scripts/hermes_memory_sync_setup.sh first."
fi

if ! git remote get-url "$REMOTE_NAME" >/dev/null 2>&1; then
  fail_soft "Remote '$REMOTE_NAME' is not configured. Add a private Git remote before cloud sync."
fi

if ! git config user.name >/dev/null 2>&1; then
  git config user.name "Hermes Memory Sync"
fi

if ! git config user.email >/dev/null 2>&1; then
  git config user.email "hermes-memory-sync@local"
fi

git branch -M "$BRANCH"
git add -A

if git diff --cached --quiet; then
  log "No memory changes. Sync skipped."
  exit 0
fi

timestamp="$(date +'%Y-%m-%d %H:%M:%S')"
git commit -m "$COMMIT_PREFIX: $timestamp"

if git ls-remote --exit-code --heads "$REMOTE_NAME" "$BRANCH" >/dev/null 2>&1; then
  git pull --rebase --autostash "$REMOTE_NAME" "$BRANCH"
fi

git push -u "$REMOTE_NAME" "$BRANCH"
log "Memory sync completed."
