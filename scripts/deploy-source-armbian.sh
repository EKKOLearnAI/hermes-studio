#!/usr/bin/env bash
set -Eeuo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }
step()  { echo -e "${BLUE}[STEP]${NC} $*"; }

trap 'err "Source deployment failed at line: $LINENO"' ERR

if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
  SUDO=()
else
  if ! command -v sudo >/dev/null 2>&1; then
    err "This script requires root or sudo."
    exit 1
  fi
  SUDO=(sudo)
fi

run() {
  "${SUDO[@]}" "$@"
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

require_safe_env_value() {
  local name="$1"
  local value="$2"
  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    err "Environment variable ${name} contains an invalid newline."
    exit 1
  fi
}

run_as_app_user() {
  local command="$1"
  shift || true

  if [[ ${#SUDO[@]} -eq 0 ]]; then
    env HOME="${APP_USER_HOME}" "$@" runuser -u "${APP_USER}" -- bash -lc "$command"
    return
  fi

  sudo -u "${APP_USER}" -H env HOME="${APP_USER_HOME}" "$@" bash -lc "$command"
}

is_clock_synchronized() {
  if ! command_exists timedatectl; then
    return 1
  fi

  local value
  value="$(timedatectl show -p NTPSynchronized --value 2>/dev/null || true)"
  [[ "$value" == "yes" ]]
}

try_sync_clock() {
  if ! command_exists timedatectl; then
    warn "timedatectl is not available. Skipping clock sync check."
    return 1
  fi

  step "Check clock sync status"
  if is_clock_synchronized; then
    info "System clock is synchronized."
    return 0
  fi

  warn "System clock is not synchronized yet. Enabling NTP and waiting."
  run timedatectl set-ntp true || true
  if command_exists systemctl; then
    run systemctl restart systemd-timesyncd || true
  fi

  local i
  for i in 1 2 3 4 5; do
    sleep 3
    if is_clock_synchronized; then
      info "System clock synchronized successfully."
      return 0
    fi
  done

  warn "System clock is still not synchronized. apt update will retry with date checks disabled."
  return 1
}

apt_update() {
  if run apt-get update -y; then
    return 0
  fi

  warn "apt-get update failed. Retrying after clock synchronization."
  try_sync_clock || true

  if run apt-get update -y; then
    return 0
  fi

  warn "apt-get update still failed after clock sync. Retrying with Acquire::Check-Date=false."
  run apt-get -o Acquire::Check-Date=false update -y
}

require_debian_like() {
  if [[ ! -r /etc/os-release ]]; then
    err "Cannot read /etc/os-release. This system is not supported."
    exit 1
  fi

  # shellcheck disable=SC1091
  source /etc/os-release
  local id_like_value="${ID_LIKE:-}"
  local id_value="${ID:-}"
  if [[ "${id_value}" != "ubuntu" && "${id_value}" != "debian" && "${id_like_value}" != *"debian"* ]]; then
    err "This script supports only Debian, Ubuntu, or Armbian-like systems."
    echo "Detected: ID=${id_value:-unknown}, ID_LIKE=${id_like_value:-unknown}"
    exit 1
  fi

  info "Detected supported system: ${PRETTY_NAME:-unknown}"
}

require_supported_arch() {
  local arch
  arch="$(uname -m)"
  case "$arch" in
    aarch64|arm64)
      NODE_ARCH="arm64"
      info "Detected supported architecture: $arch"
      ;;
    x86_64|amd64)
      NODE_ARCH="x64"
      info "Detected supported architecture: $arch"
      ;;
    *)
      err "Unsupported or unverified architecture: $arch"
      err "Use an arm64/aarch64 or amd64/x86_64 device."
      exit 1
      ;;
  esac
}

install_base_packages() {
  step "Install base packages"
  apt_update
  run apt-get install -y \
    ca-certificates \
    curl \
    ffmpeg \
    git \
    gnupg \
    lsb-release \
    python3 \
    python3-pip \
    python3-venv \
    build-essential \
    pkg-config \
    xz-utils \
    fonts-wqy-zenhei \
    fonts-wqy-microhei
}

ensure_app_user() {
  step "Prepare runtime user"
  if id "${APP_USER}" >/dev/null 2>&1; then
    info "Runtime user already exists: ${APP_USER}"
  else
    run useradd --create-home --shell /bin/bash "${APP_USER}"
    info "Created runtime user: ${APP_USER}"
  fi

  APP_USER_HOME="$(getent passwd "${APP_USER}" | cut -d: -f6)"
  if [[ -z "${APP_USER_HOME}" ]]; then
    err "Failed to resolve HOME for runtime user ${APP_USER}."
    exit 1
  fi

  run mkdir -p "${APP_USER_HOME}/.local/bin"
  run chown -R "${APP_USER}:${APP_USER}" "${APP_USER_HOME}/.local"
}

resolve_repo_dir() {
  local script_root
  script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

  if [[ -f "${script_root}/package.json" ]]; then
    DEPLOY_DIR="${script_root}"
    info "Using source tree next to the script: ${DEPLOY_DIR}"
    return 0
  fi

  if [[ -f "${DEPLOY_DIR}/package.json" ]]; then
    info "Using extracted source tree from DEPLOY_DIR: ${DEPLOY_DIR}"
    return 0
  fi

  err "No source tree found."
  err "Expected package.json in either:"
  err "  1. the directory next to this script, or"
  err "  2. DEPLOY_DIR=${DEPLOY_DIR}"
  err "Upload and extract the local source package first, then rerun this script."
  exit 1
}

prepare_deploy_dirs() {
  step "Prepare deployment directories"
  run mkdir -p "${DEPLOY_DIR}" "${HERMES_HOME_DIR}" "${NODE_INSTALL_DIR}" "$(dirname "${SERVICE_ENV_FILE}")"
  run chown -R "${APP_USER}:${APP_USER}" "${DEPLOY_DIR}" "${HERMES_HOME_DIR}"
  info "Source directory: ${DEPLOY_DIR}"
  info "Hermes data directory: ${HERMES_HOME_DIR}"
}

download_file() {
  local output="$1"
  shift

  local url
  for url in "$@"; do
    if curl -fsSL --connect-timeout 10 --retry 2 --retry-delay 2 "$url" -o "$output"; then
      info "Downloaded successfully: $url"
      return 0
    fi
    warn "Download failed, trying next URL: $url"
  done

  return 1
}

install_node() {
  step "Install Node.js ${NODE_VERSION}"

  local installed_major=""
  if [[ -x "${NODE_BIN}" ]]; then
    installed_major="$("${NODE_BIN}" -p "process.versions.node.split('.')[0]" 2>/dev/null || true)"
  fi
  if [[ "${installed_major}" =~ ^[0-9]+$ ]] && [[ "${installed_major}" -ge "${NODE_REQUIRED_MAJOR}" ]]; then
    info "Node.js already satisfies the requirement: $("${NODE_BIN}" -v)"
    return 0
  fi

  local tmp_dir archive_path
  tmp_dir="$(mktemp -d)"
  archive_path="${tmp_dir}/node.tar.xz"

  download_file "${archive_path}" \
    "${NODE_MIRROR_URL%/}/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
    "${NODE_FALLBACK_URL%/}/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"

  run rm -rf "${NODE_INSTALL_DIR}"
  run mkdir -p "${NODE_INSTALL_DIR}"
  run tar -xJf "${archive_path}" --strip-components=1 -C "${NODE_INSTALL_DIR}"

  rm -rf "${tmp_dir}"
  info "Node.js installation completed: $("${NODE_BIN}" -v)"
}

install_hermes_agent() {
  step "Install Hermes Agent"

  local hermes_bin_candidate
  hermes_bin_candidate="${APP_USER_HOME}/.local/bin/hermes"
  if run_as_app_user "test -x '${hermes_bin_candidate}'"; then
    info "Hermes is already installed. Skipping installation."
    return 0
  fi

  # Mode A: Install from Wheel URL (Fast, no git clone)
  if [[ -n "${HERMES_AGENT_WHEEL_URL}" ]]; then
    info "Installing Hermes Agent from pre-built wheel: ${HERMES_AGENT_WHEEL_URL}"
    local venv_dir="${APP_USER_HOME}/.hermes/hermes-agent-venv"
    local bin_dir="${APP_USER_HOME}/.local/bin"

    run_as_app_user "mkdir -p '${venv_dir}' '${bin_dir}'"
    run_as_app_user "python3 -m venv '${venv_dir}'"
    run_as_app_user "'${venv_dir}/bin/pip' install --upgrade pip"
    run_as_app_user "'${venv_dir}/bin/pip' install '${HERMES_AGENT_WHEEL_URL}'"

    # Link the command
    run_as_app_user "ln -sf '${venv_dir}/bin/hermes' '${bin_dir}/hermes'"
    info "Hermes installed from wheel at: ${hermes_bin_candidate}"
    return 0
  fi

  # Mode B: Official Installer (Legacy/Source)
  local install_command
  install_command=$(cat <<'EOF'
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
tmp_installer="$(mktemp)"
cleanup() {
  rm -f "$tmp_installer"
}
trap cleanup EXIT
for url in \
  "${HERMES_INSTALLER_MIRROR}" \
  "${HERMES_INSTALLER_FALLBACK}"
do
  if curl -fsSL --connect-timeout 10 --retry 2 --retry-delay 2 "$url" -o "$tmp_installer"; then
    bash "$tmp_installer" ${HERMES_INSTALL_FLAGS}
    exit 0
  fi
done
echo "Failed to download the Hermes installer script." >&2
exit 1
EOF
)

  run_as_app_user "${install_command}" \
    HERMES_INSTALL_FLAGS="${HERMES_INSTALL_FLAGS}" \
    HERMES_INSTALLER_MIRROR="${HERMES_INSTALLER_MIRROR}" \
    HERMES_INSTALLER_FALLBACK="${HERMES_INSTALLER_FALLBACK}"

  if ! run_as_app_user "test -x '${hermes_bin_candidate}'"; then
    err "Hermes installation completed, but the binary was not found: ${hermes_bin_candidate}"
    exit 1
  fi

  info "Hermes installed at: ${hermes_bin_candidate}"
}

write_npmrc() {
  step "Write npm mirror configuration"
  run tee "${APP_USER_HOME}/.npmrc" >/dev/null <<EOF
registry=${NPM_REGISTRY}
disturl=${NODE_MIRROR_URL%/}
electron_mirror=${NPM_BINARY_MIRROR_PREFIX%/}/electron/
puppeteer_download_host=${NPM_BINARY_MIRROR_PREFIX%/}
sharp_binary_host=${NPM_BINARY_MIRROR_PREFIX%/}/sharp
sharp_libvips_binary_host=${NPM_BINARY_MIRROR_PREFIX%/}/sharp-libvips
sqlite3_binary_site=${NPM_BINARY_MIRROR_PREFIX%/}/sqlite3
sass_binary_site=${NPM_BINARY_MIRROR_PREFIX%/}/node-sass
chromedriver_cdnurl=${NPM_BINARY_MIRROR_PREFIX%/}/chromedriver
operadriver_cdnurl=${NPM_BINARY_MIRROR_PREFIX%/}/operadriver
phantomjs_cdnurl=${NPM_BINARY_MIRROR_PREFIX%/}/phantomjs
selenium_cdnurl=${NPM_BINARY_MIRROR_PREFIX%/}/selenium
EOF
  run chown "${APP_USER}:${APP_USER}" "${APP_USER_HOME}/.npmrc"
  info "Wrote ${APP_USER_HOME}/.npmrc"
}

install_webui_dependencies() {
  if [[ -n "${WEBUI_BUNDLE_URL}" ]]; then
    step "Install hermes-web-ui from bundle"
    local tmp_bundle
    tmp_bundle="$(mktemp)"
    if download_file "${tmp_bundle}" "${WEBUI_BUNDLE_URL}"; then
      run chown "${APP_USER}:${APP_USER}" "${tmp_bundle}"
      run_as_app_user "cd '${DEPLOY_DIR}' && tar -xzf '${tmp_bundle}'"
      rm -f "${tmp_bundle}"
      info "Extracted web-ui bundle to ${DEPLOY_DIR}"
      return 0
    fi
    warn "Failed to download web-ui bundle. Falling back to npm install."
  fi

  step "Install hermes-web-ui dependencies"
  local path_env
  path_env="${NODE_INSTALL_DIR}/bin:${APP_USER_HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

  run chown -R "${APP_USER}:${APP_USER}" "${DEPLOY_DIR}"
  run_as_app_user "cd '${DEPLOY_DIR}' && PATH='${path_env}' HERMES_WEB_UI_SKIP_PREPARE=1 npm install --include=dev && PATH='${path_env}' npm ls --depth=0 @vscode/markdown-it-katex naive-ui typescript vite vue-tsc >/dev/null"
}

check_webui_dependencies() {
  step "Check installed Web UI dependencies"

  if [[ -f "${DEPLOY_DIR}/dist/server/index.js" ]]; then
    info "Pre-built artifacts detected. Skipping build-time dependency check."
    return 0
  fi

  run test -f "${DEPLOY_DIR}/node_modules/naive-ui/package.json"
  run test -f "${DEPLOY_DIR}/node_modules/naive-ui/es/index.d.ts"
  run test -f "${DEPLOY_DIR}/node_modules/typescript/package.json"
  run test -f "${DEPLOY_DIR}/node_modules/vue-tsc/package.json"
  run test -f "${DEPLOY_DIR}/node_modules/vite/package.json"
  info "Required build-time dependencies are present."
}

build_webui() {
  if [[ -f "${DEPLOY_DIR}/dist/server/index.js" ]]; then
    info "Found pre-built artifacts in dist/. Skipping build_webui."
    return 0
  fi

  step "Build hermes-web-ui"
  local path_env
  path_env="${NODE_INSTALL_DIR}/bin:${APP_USER_HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  run_as_app_user "cd '${DEPLOY_DIR}' && PATH='${path_env}' npm run build"
}

write_service_env() {
  step "Write service environment file"
  local hermes_bin
  local hermes_agent_root
  hermes_bin="${APP_USER_HOME}/.local/bin/hermes"
  hermes_agent_root=""
  if [[ -z "${HERMES_AGENT_WHEEL_URL}" ]]; then
    hermes_agent_root="${APP_USER_HOME}/.hermes/hermes-agent"
  fi

  run tee "${SERVICE_ENV_FILE}" >/dev/null <<EOF
PORT=${PORT}
BIND_HOST=${BIND_HOST}
NODE_ENV=production
HOME=${APP_USER_HOME}
PATH=${NODE_INSTALL_DIR}/bin:${APP_USER_HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
HERMES_HOME=${HERMES_HOME_DIR}
HERMES_BIN=${hermes_bin}
${hermes_agent_root:+HERMES_AGENT_ROOT=${hermes_agent_root}}
HERMES_WEB_UI_HOME=${APP_USER_HOME}/.hermes-web-ui
LANG=C.UTF-8
LC_ALL=C.UTF-8
EOF

  run chown root:root "${SERVICE_ENV_FILE}"
  run chmod 0644 "${SERVICE_ENV_FILE}"
  info "Wrote ${SERVICE_ENV_FILE}"
}

wait_for_http_ready() {
  local url="$1"
  local expected_fragment="$2"
  local max_attempts="${3:-20}"
  local i
  for ((i=1; i<=max_attempts; i++)); do
    local body
    if body="$(curl -fsS --max-time 5 "$url" 2>/dev/null)" && [[ "$body" == *"$expected_fragment"* ]]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

require_log_dir_writable() {
  local state_dir="${APP_USER_HOME}/.hermes-web-ui"
  local log_dir="${state_dir}/logs"
  step "Check runtime directory permissions"
  run mkdir -p "${log_dir}"
  run chown -R "${APP_USER}:${APP_USER}" "${state_dir}"
  run_as_app_user "test -w '${state_dir}' && test -w '${log_dir}'"
  info "Runtime directories are writable: ${log_dir}"
}

check_runtime_artifacts() {
  local hermes_bin="${APP_USER_HOME}/.local/bin/hermes"
  step "Check runtime artifacts"
  run test -x "${NODE_BIN}"
  run_as_app_user "test -x '${hermes_bin}' && '${hermes_bin}' --version >/dev/null"
  run test -f "${DEPLOY_DIR}/dist/server/index.js"
  run test -f "${DEPLOY_DIR}/dist/client/index.html"
  info "Node, Hermes, and build artifacts look good."
}

check_bridge_status() {
  local bridge_log="${APP_USER_HOME}/.hermes-web-ui/logs/bridge.log"
  step "Check agent bridge log"
  if [[ ! -f "${bridge_log}" ]]; then
    warn "bridge.log does not exist yet. Skipping bridge stability check."
    return 0
  fi

  if run bash -lc "tail -n 200 '${bridge_log}' | grep -E 'bridge exited unexpectedly|agent-bridge\\] exited code='" >/dev/null 2>&1; then
    err "Detected an unexpected agent bridge exit. Check ${bridge_log}"
    return 1
  fi

  info "No unexpected agent bridge exits detected."
}

post_deploy_self_check() {
  local probe_url="http://127.0.0.1:${PORT}"
  step "Run post-deploy self-checks"

  if ! run systemctl is-active --quiet "${SYSTEMD_SERVICE_NAME}"; then
    err "systemd service is not active: ${SYSTEMD_SERVICE_NAME}"
    run systemctl status "${SYSTEMD_SERVICE_NAME}" --no-pager || true
    return 1
  fi
  info "systemd service is active."

  check_runtime_artifacts
  require_log_dir_writable

  if ! wait_for_http_ready "${probe_url}/health" "\"status\":\"ok\""; then
    err "Health check failed: ${probe_url}/health"
    run journalctl -u "${SYSTEMD_SERVICE_NAME}" -n 120 --no-pager || true
    return 1
  fi
  info "Health check passed."

  if ! wait_for_http_ready "${probe_url}/api/auth/status" "\"hasPasswordLogin\":true"; then
    err "Auth status check failed: ${probe_url}/api/auth/status"
    run journalctl -u "${SYSTEMD_SERVICE_NAME}" -n 120 --no-pager || true
    return 1
  fi
  info "Auth status check passed."

  check_bridge_status
}

install_systemd_service() {
  step "Install systemd service"

  local rendered_service
  rendered_service="$(mktemp)"

  python3 - "${SERVICE_TEMPLATE}" "${rendered_service}" \
    "${APP_USER}" "${APP_USER_HOME}" "${DEPLOY_DIR}" "${SERVICE_ENV_FILE}" \
    "${NODE_BIN}" <<'PY'
from pathlib import Path
import sys

template_path = Path(sys.argv[1])
output_path = Path(sys.argv[2])
replacements = {
    "{{APP_USER}}": sys.argv[3],
    "{{APP_USER_HOME}}": sys.argv[4],
    "{{DEPLOY_DIR}}": sys.argv[5],
    "{{SERVICE_ENV_FILE}}": sys.argv[6],
    "{{NODE_BIN}}": sys.argv[7],
}

content = template_path.read_text(encoding="utf-8")
for old, new in replacements.items():
    content = content.replace(old, new)
output_path.write_text(content, encoding="utf-8")
PY

  run cp "${rendered_service}" "/etc/systemd/system/${SYSTEMD_SERVICE_NAME}"
  rm -f "${rendered_service}"
  run systemctl daemon-reload
  run systemctl enable --now "${SYSTEMD_SERVICE_NAME}"
  info "systemd service started: ${SYSTEMD_SERVICE_NAME}"
}

show_summary() {
  local server_url
  server_url="http://$(hostname -I 2>/dev/null | awk '{print $1}'):${PORT}"

  echo
  info "Source deployment completed"
  echo "----------------------------------------"
  echo "Server URL: ${server_url}"
  echo "Local URL: http://127.0.0.1:${PORT}"
  echo "Source directory: ${DEPLOY_DIR}"
  echo "Hermes data directory: ${HERMES_HOME_DIR}"
  echo "Runtime user: ${APP_USER}"
  echo
  echo "Initial Hermes setup:"
  echo "  sudo -u ${APP_USER} -H env HERMES_HOME=${HERMES_HOME_DIR} ${APP_USER_HOME}/.local/bin/hermes setup"
  echo "  sudo -u ${APP_USER} -H env HERMES_HOME=${HERMES_HOME_DIR} ${APP_USER_HOME}/.local/bin/hermes model"
  echo
  echo "Common commands:"
  echo "  sudo systemctl status ${SYSTEMD_SERVICE_NAME}"
  echo "  sudo journalctl -u ${SYSTEMD_SERVICE_NAME} -f"
  echo "  sudo systemctl restart ${SYSTEMD_SERVICE_NAME}"
  echo "  sudo systemctl stop ${SYSTEMD_SERVICE_NAME}"
  echo
}

DEPLOY_DIR="${DEPLOY_DIR:-/opt/hermes-web-ui}"
PORT="${PORT:-6060}"
BIND_HOST="${BIND_HOST:-0.0.0.0}"
APP_USER="${APP_USER:-hermesui}"
HERMES_HOME_DIR="${HERMES_HOME_DIR:-${DEPLOY_DIR}/hermes_data}"
NODE_REQUIRED_MAJOR="${NODE_REQUIRED_MAJOR:-23}"
NODE_VERSION="${NODE_VERSION:-23.11.1}"
NODE_INSTALL_DIR="${NODE_INSTALL_DIR:-/opt/node-v${NODE_REQUIRED_MAJOR}}"
NODE_BIN="${NODE_INSTALL_DIR}/bin/node"
NODE_MIRROR_URL="${NODE_MIRROR_URL:-https://npmmirror.com/mirrors/node}"
NODE_FALLBACK_URL="${NODE_FALLBACK_URL:-https://nodejs.org/dist}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
NPM_BINARY_MIRROR_PREFIX="${NPM_BINARY_MIRROR_PREFIX:-https://cdn.npmmirror.com/binaries}"
HERMES_INSTALLER_MIRROR="${HERMES_INSTALLER_MIRROR:-https://cdn.jsdelivr.net/gh/NousResearch/hermes-agent@main/scripts/install.sh}"
HERMES_INSTALLER_FALLBACK="${HERMES_INSTALLER_FALLBACK:-https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh}"
HERMES_AGENT_WHEEL_URL="${HERMES_AGENT_WHEEL_URL:-https://github.com/NousResearch/hermes-agent/releases/download/v2026.5.29.2/hermes_agent-0.15.2-py3-none-any.whl}"
WEBUI_BUNDLE_URL="${WEBUI_BUNDLE_URL:-}"
HERMES_INSTALL_FLAGS="${HERMES_INSTALL_FLAGS:---skip-setup --skip-browser}"
SERVICE_TEMPLATE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hermes-web-ui.service"
SYSTEMD_SERVICE_NAME="${SYSTEMD_SERVICE_NAME:-hermes-web-ui.service}"
SERVICE_ENV_FILE="${SERVICE_ENV_FILE:-/etc/default/hermes-web-ui}"
APP_USER_HOME=""
NODE_ARCH=""

require_safe_env_value "PORT" "${PORT}"
require_safe_env_value "BIND_HOST" "${BIND_HOST}"
require_safe_env_value "APP_USER" "${APP_USER}"
require_safe_env_value "DEPLOY_DIR" "${DEPLOY_DIR}"
require_safe_env_value "HERMES_HOME_DIR" "${HERMES_HOME_DIR}"
require_safe_env_value "SERVICE_ENV_FILE" "${SERVICE_ENV_FILE}"

echo
echo "hermes / hermes-web-ui source deployment"
echo "=================================="
echo

require_debian_like
require_supported_arch
install_base_packages
ensure_app_user
resolve_repo_dir
prepare_deploy_dirs
install_node
install_hermes_agent
write_npmrc
install_webui_dependencies
check_webui_dependencies
build_webui
write_service_env
install_systemd_service
post_deploy_self_check
show_summary
