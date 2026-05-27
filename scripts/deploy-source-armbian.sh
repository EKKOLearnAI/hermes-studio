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

trap 'err "源码部署失败，出错行号: $LINENO"' ERR

if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
  SUDO=()
else
  if ! command -v sudo >/dev/null 2>&1; then
    err "当前不是 root，且系统中没有 sudo。请使用 root 运行该脚本。"
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
    err "环境变量 ${name} 包含非法换行符。"
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
    warn "系统未提供 timedatectl，跳过时间同步检测。"
    return 1
  fi

  step "检查系统时间同步状态"
  if is_clock_synchronized; then
    info "系统时间已同步。"
    return 0
  fi

  warn "系统时间尚未同步，尝试启用 NTP 并等待同步。"
  run timedatectl set-ntp true || true
  if command_exists systemctl; then
    run systemctl restart systemd-timesyncd || true
  fi

  local i
  for i in 1 2 3 4 5; do
    sleep 3
    if is_clock_synchronized; then
      info "系统时间同步成功。"
      return 0
    fi
  done

  warn "系统时间仍未同步，将在 apt update 时尝试跳过日期校验。"
  return 1
}

apt_update() {
  if run apt-get update -y; then
    return 0
  fi

  warn "apt-get update 失败，尝试自动同步系统时间后重试。"
  try_sync_clock || true

  if run apt-get update -y; then
    return 0
  fi

  warn "时间同步后仍失败，使用 Acquire::Check-Date=false 兜底更新软件源。"
  run apt-get -o Acquire::Check-Date=false update -y
}

require_debian_like() {
  if [[ ! -r /etc/os-release ]]; then
    err "无法读取 /etc/os-release，当前系统不受支持。"
    exit 1
  fi

  # shellcheck disable=SC1091
  source /etc/os-release
  local id_like_value="${ID_LIKE:-}"
  local id_value="${ID:-}"
  if [[ "${id_value}" != "ubuntu" && "${id_value}" != "debian" && "${id_like_value}" != *"debian"* ]]; then
    err "当前脚本仅支持 Debian/Ubuntu/Armbian 系列系统。"
    echo "检测到: ID=${id_value:-unknown}, ID_LIKE=${id_like_value:-unknown}"
    exit 1
  fi

  info "系统检测通过: ${PRETTY_NAME:-unknown}"
}

require_supported_arch() {
  local arch
  arch="$(uname -m)"
  case "$arch" in
    aarch64|arm64)
      NODE_ARCH="arm64"
      info "架构检测通过: $arch"
      ;;
    x86_64|amd64)
      NODE_ARCH="x64"
      info "架构检测通过: $arch"
      ;;
    *)
      err "当前架构暂未验证: $arch"
      err "建议使用 arm64/aarch64 或 amd64/x86_64 设备。"
      exit 1
      ;;
  esac
}

install_base_packages() {
  step "安装基础依赖"
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
    xz-utils
}

ensure_app_user() {
  step "准备运行用户"
  if id "${APP_USER}" >/dev/null 2>&1; then
    info "运行用户已存在: ${APP_USER}"
  else
    run useradd --create-home --shell /bin/bash "${APP_USER}"
    info "已创建运行用户: ${APP_USER}"
  fi

  APP_USER_HOME="$(getent passwd "${APP_USER}" | cut -d: -f6)"
  if [[ -z "${APP_USER_HOME}" ]]; then
    err "无法解析运行用户 ${APP_USER} 的 HOME 目录。"
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
    info "检测到仓库目录: ${DEPLOY_DIR}"
    return 0
  fi

  if [[ -f "${DEPLOY_DIR}/package.json" ]]; then
    info "使用部署目录中的现有仓库: ${DEPLOY_DIR}"
    return 0
  fi

  step "拉取源码仓库"
  run mkdir -p "$(dirname "${DEPLOY_DIR}")"
  run git clone --depth 1 --branch "${REPO_REF}" "${REPO_URL}" "${DEPLOY_DIR}"
  info "已克隆源码到: ${DEPLOY_DIR}"
}

prepare_deploy_dirs() {
  step "准备部署目录"
  run mkdir -p "${DEPLOY_DIR}" "${HERMES_HOME_DIR}" "${NODE_INSTALL_DIR}" "$(dirname "${SERVICE_ENV_FILE}")"
  run chown -R "${APP_USER}:${APP_USER}" "${DEPLOY_DIR}" "${HERMES_HOME_DIR}"
  info "代码目录: ${DEPLOY_DIR}"
  info "Hermes 数据目录: ${HERMES_HOME_DIR}"
}

download_file() {
  local output="$1"
  shift

  local url
  for url in "$@"; do
    if curl -fsSL --connect-timeout 10 --retry 2 --retry-delay 2 "$url" -o "$output"; then
      info "下载成功: $url"
      return 0
    fi
    warn "下载失败，尝试下一个地址: $url"
  done

  return 1
}

install_node() {
  step "安装 Node.js ${NODE_VERSION}"

  local installed_major=""
  if [[ -x "${NODE_BIN}" ]]; then
    installed_major="$("${NODE_BIN}" -p "process.versions.node.split('.')[0]" 2>/dev/null || true)"
  fi
  if [[ "${installed_major}" =~ ^[0-9]+$ ]] && [[ "${installed_major}" -ge "${NODE_REQUIRED_MAJOR}" ]]; then
    info "Node.js 已满足要求: $("${NODE_BIN}" -v)"
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
  info "Node.js 安装完成: $("${NODE_BIN}" -v)"
}

install_hermes_agent() {
  step "安装 Hermes Agent"

  local hermes_bin_candidate
  hermes_bin_candidate="${APP_USER_HOME}/.local/bin/hermes"
  if run_as_app_user "test -x '${hermes_bin_candidate}'"; then
    info "Hermes 已安装，跳过安装步骤。"
    return 0
  fi

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
echo "Hermes 安装脚本下载失败" >&2
exit 1
EOF
)

  run_as_app_user "${install_command}" \
    HERMES_INSTALL_FLAGS="${HERMES_INSTALL_FLAGS}" \
    HERMES_INSTALLER_MIRROR="${HERMES_INSTALLER_MIRROR}" \
    HERMES_INSTALLER_FALLBACK="${HERMES_INSTALLER_FALLBACK}"

  if ! run_as_app_user "test -x '${hermes_bin_candidate}'"; then
    err "Hermes 安装完成后仍未找到命令: ${hermes_bin_candidate}"
    exit 1
  fi

  info "Hermes 已安装到: ${hermes_bin_candidate}"
}

write_npmrc() {
  step "写入 npm 国内源配置"
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
  info "已写入 ${APP_USER_HOME}/.npmrc"
}

install_webui_dependencies() {
  step "安装 hermes-web-ui 依赖"
  local path_env
  path_env="${NODE_INSTALL_DIR}/bin:${APP_USER_HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

  run chown -R "${APP_USER}:${APP_USER}" "${DEPLOY_DIR}"
  run_as_app_user "cd '${DEPLOY_DIR}' && PATH='${path_env}' npm install --include=dev && PATH='${path_env}' npm ls --depth=0 @vscode/markdown-it-katex vite vue-tsc >/dev/null"
}

build_webui() {
  step "构建 hermes-web-ui"
  local path_env
  path_env="${NODE_INSTALL_DIR}/bin:${APP_USER_HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  run_as_app_user "cd '${DEPLOY_DIR}' && PATH='${path_env}' npm run build"
}

write_service_env() {
  step "写入服务环境变量"
  local hermes_bin
  hermes_bin="${APP_USER_HOME}/.local/bin/hermes"

  run tee "${SERVICE_ENV_FILE}" >/dev/null <<EOF
PORT=${PORT}
BIND_HOST=${BIND_HOST}
NODE_ENV=production
HOME=${APP_USER_HOME}
PATH=${NODE_INSTALL_DIR}/bin:${APP_USER_HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
HERMES_HOME=${HERMES_HOME_DIR}
HERMES_BIN=${hermes_bin}
HERMES_AGENT_ROOT=${APP_USER_HOME}/.hermes/hermes-agent
HERMES_WEB_UI_HOME=${APP_USER_HOME}/.hermes-web-ui
EOF

  run chown root:root "${SERVICE_ENV_FILE}"
  run chmod 0644 "${SERVICE_ENV_FILE}"
  info "已生成 ${SERVICE_ENV_FILE}"
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
  step "检查运行时目录权限"
  run mkdir -p "${log_dir}"
  run chown -R "${APP_USER}:${APP_USER}" "${state_dir}"
  run_as_app_user "test -w '${state_dir}' && test -w '${log_dir}'"
  info "运行时目录可写: ${log_dir}"
}

check_runtime_artifacts() {
  local hermes_bin="${APP_USER_HOME}/.local/bin/hermes"
  step "检查运行时工件"
  run test -x "${NODE_BIN}"
  run_as_app_user "test -x '${hermes_bin}' && '${hermes_bin}' --version >/dev/null"
  run test -f "${DEPLOY_DIR}/dist/server/index.js"
  run test -f "${DEPLOY_DIR}/dist/client/index.html"
  info "Node、Hermes 与构建产物检查通过。"
}

check_bridge_status() {
  local bridge_log="${APP_USER_HOME}/.hermes-web-ui/logs/bridge.log"
  step "检查 agent bridge 日志"
  if [[ ! -f "${bridge_log}" ]]; then
    warn "bridge 日志不存在，跳过 bridge 稳定性检查。"
    return 0
  fi

  if run bash -lc "tail -n 200 '${bridge_log}' | grep -E 'bridge exited unexpectedly|agent-bridge\\] exited code='" >/dev/null 2>&1; then
    err "检测到 agent bridge 异常退出，请查看 ${bridge_log}"
    return 1
  fi

  info "agent bridge 日志未发现异常退出。"
}

post_deploy_self_check() {
  local probe_url="http://127.0.0.1:${PORT}"
  step "执行部署后自检"

  if ! run systemctl is-active --quiet "${SYSTEMD_SERVICE_NAME}"; then
    err "systemd 服务未处于 active 状态: ${SYSTEMD_SERVICE_NAME}"
    run systemctl status "${SYSTEMD_SERVICE_NAME}" --no-pager || true
    return 1
  fi
  info "systemd 服务状态正常。"

  check_runtime_artifacts
  require_log_dir_writable

  if ! wait_for_http_ready "${probe_url}/health" "\"status\":\"ok\""; then
    err "健康检查未通过: ${probe_url}/health"
    run journalctl -u "${SYSTEMD_SERVICE_NAME}" -n 120 --no-pager || true
    return 1
  fi
  info "健康检查通过。"

  if ! wait_for_http_ready "${probe_url}/api/auth/status" "\"hasPasswordLogin\":true"; then
    err "认证状态检查未通过: ${probe_url}/api/auth/status"
    run journalctl -u "${SYSTEMD_SERVICE_NAME}" -n 120 --no-pager || true
    return 1
  fi
  info "认证状态检查通过。"

  check_bridge_status
}

install_systemd_service() {
  step "安装 systemd 服务"

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
  info "systemd 服务已启动: ${SYSTEMD_SERVICE_NAME}"
}

show_summary() {
  local server_url
  server_url="http://$(hostname -I 2>/dev/null | awk '{print $1}'):${PORT}"

  echo
  info "源码部署完成"
  echo "----------------------------------------"
  echo "访问地址: ${server_url}"
  echo "本机地址: http://127.0.0.1:${PORT}"
  echo "代码目录: ${DEPLOY_DIR}"
  echo "Hermes 数据目录: ${HERMES_HOME_DIR}"
  echo "运行用户: ${APP_USER}"
  echo
  echo "首次 Hermes 配置:"
  echo "  sudo -u ${APP_USER} -H env HERMES_HOME=${HERMES_HOME_DIR} ${APP_USER_HOME}/.local/bin/hermes setup"
  echo "  sudo -u ${APP_USER} -H env HERMES_HOME=${HERMES_HOME_DIR} ${APP_USER_HOME}/.local/bin/hermes model"
  echo
  echo "常用命令:"
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
REPO_URL="${REPO_URL:-https://github.com/EKKOLearnAI/hermes-web-ui.git}"
REPO_REF="${REPO_REF:-main}"
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
echo "hermes / hermes-web-ui 源码一键部署"
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
build_webui
write_service_env
install_systemd_service
post_deploy_self_check
show_summary
