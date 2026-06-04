#!/usr/bin/env bash
set -Eeuo pipefail

log() {
  printf '[image-verify] %s\n' "$*"
}

fail() {
  printf '[image-verify] ERROR: %s\n' "$*" >&2
  exit 1
}

check_service() {
  local service_name="$1"
  if ! systemctl is-active --quiet "${service_name}"; then
    systemctl status "${service_name}" --no-pager || true
    fail "Service is not active: ${service_name}"
  fi
  log "Service active: ${service_name}"
}

check_http() {
  local url="$1"
  local expected="$2"
  local body
  body="$(curl -fsS --max-time 5 "${url}")" || fail "Request failed: ${url}"
  if [[ "${body}" != *"${expected}"* ]]; then
    fail "Unexpected response from ${url}"
  fi
  log "HTTP check passed: ${url}"
}

EXPECTED_MODEL="${EXPECTED_MODEL:-}"
ACTUAL_MODEL="$(tr -d '\0' </proc/device-tree/model 2>/dev/null || echo unknown)"

if [[ -n "${EXPECTED_MODEL}" && "${ACTUAL_MODEL}" != "${EXPECTED_MODEL}" ]]; then
  fail "Model mismatch. Expected '${EXPECTED_MODEL}', got '${ACTUAL_MODEL}'"
fi

log "Detected model: ${ACTUAL_MODEL}"
check_service "quanthermes"
check_service "quanthermes-kiosk"
check_service "hermes-web-ui.service"

ss -lntpH '( sport = :80 )' | grep -q ':80' || fail "Port 80 is not listening"
ss -lntpH '( sport = :6060 )' | grep -q ':6060' || fail "Port 6060 is not listening"
log "Ports 80 and 6060 are listening"

check_http "http://127.0.0.1/api/status" "\"displayMode\":"
check_http "http://127.0.0.1:6060/health" "\"status\":\"ok\""

if pgrep -x fcitx5 >/dev/null 2>&1; then
  log "fcitx5 process detected"
else
  fail "fcitx5 process not found"
fi

log "Image verification passed"
