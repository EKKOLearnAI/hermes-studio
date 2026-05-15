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

trap 'err "部署失败，出错行号: $LINENO"' ERR

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
    aarch64|arm64|x86_64|amd64)
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
    gnupg \
    lsb-release \
    apt-transport-https \
    software-properties-common
}

install_docker() {
  if command_exists docker && run docker compose version >/dev/null 2>&1; then
    info "Docker 与 Docker Compose 已安装，跳过安装。"
    return
  fi

  step "安装 Docker 与 Docker Compose 插件"

  run install -m 0755 -d /etc/apt/keyrings
  if [[ ! -f /etc/apt/keyrings/docker.asc ]]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | run gpg --dearmor -o /etc/apt/keyrings/docker.asc
    run chmod a+r /etc/apt/keyrings/docker.asc
  fi

  local arch codename repo_os
  arch="$(dpkg --print-architecture)"
  # shellcheck disable=SC1091
  source /etc/os-release
  codename="${VERSION_CODENAME:-${UBUNTU_CODENAME:-noble}}"
  repo_os="ubuntu"
  if [[ "${ID:-}" == "debian" ]]; then
    repo_os="debian"
  fi

  cat <<EOF | run tee /etc/apt/sources.list.d/docker.list >/dev/null
deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${repo_os} ${codename} stable
EOF

  apt_update
  run apt-get install -y \
    docker-ce \
    docker-ce-cli \
    containerd.io \
    docker-buildx-plugin \
    docker-compose-plugin

  run systemctl enable --now docker
  info "Docker 安装完成。"
}

ensure_docker_running() {
  step "检查 Docker 服务状态"
  run systemctl enable --now docker
  run docker version >/dev/null
  run docker compose version >/dev/null
  info "Docker 服务运行正常。"
}

prepare_dirs() {
  step "准备部署目录"
  run mkdir -p "${DEPLOY_DIR}" "${HERMES_DATA_DIR}" "${HERMES_DATA_DIR}/hermes-web-ui"
  info "部署目录: ${DEPLOY_DIR}"
  info "数据目录: ${HERMES_DATA_DIR}"
}

write_env_file() {
  step "写入部署环境变量"
  run tee "${ENV_FILE}" >/dev/null <<EOF
WEBUI_IMAGE=${WEBUI_IMAGE}
WEBUI_CONTAINER_NAME=${WEBUI_CONTAINER_NAME}
PORT=${PORT}
AUTH_DISABLED=${AUTH_DISABLED}
HERMES_DATA_DIR=${HERMES_DATA_DIR}
EOF
  info "已生成 ${ENV_FILE}"
}

write_compose_file() {
  step "写入 docker-compose.yml"
  if [[ -f "${LOCAL_COMPOSE_FILE}" ]]; then
    run cp "${LOCAL_COMPOSE_FILE}" "${COMPOSE_FILE}"
    info "使用仓库内 docker-compose.yml"
    return
  fi

  curl -fsSL "${RAW_BASE_URL}/docker-compose.yml" | run tee "${COMPOSE_FILE}" >/dev/null
  info "已从远程下载 docker-compose.yml"
}

pull_and_start() {
  step "拉取并启动 hermes-web-ui 容器"
  (
    cd "${DEPLOY_DIR}"
    run docker compose pull
    run docker compose up -d
  )
  info "容器已启动。"
}

wait_for_webui() {
  step "等待 Web UI 就绪"
  local url="http://127.0.0.1:${PORT}/health"
  local attempts=60
  local i
  for ((i = 1; i <= attempts; i++)); do
    if curl -fsSL --max-time 5 "${url}" >/dev/null 2>&1; then
      info "Web UI 已可访问: ${url}"
      return
    fi
    sleep 2
  done
  warn "Web UI 健康检查超时，你可以稍后手动执行: curl ${url}"
}

show_summary() {
  echo
  info "部署完成"
  echo "----------------------------------------"
  echo "访问地址: http://$(hostname -I 2>/dev/null | awk '{print $1}'):${PORT}"
  echo "本机地址: http://127.0.0.1:${PORT}"
  echo "部署目录: ${DEPLOY_DIR}"
  echo "数据目录: ${HERMES_DATA_DIR}"
  echo
  echo "常用命令:"
  echo "  cd ${DEPLOY_DIR} && sudo docker compose ps"
  echo "  cd ${DEPLOY_DIR} && sudo docker compose logs -f ${WEBUI_CONTAINER_NAME}"
  echo "  cd ${DEPLOY_DIR} && sudo docker compose restart"
  echo "  cd ${DEPLOY_DIR} && sudo docker compose down"
  echo
  echo "人工绑定 / 配置 Hermes:"
  echo "  sudo docker exec -it ${WEBUI_CONTAINER_NAME} /opt/hermes/.venv/bin/hermes setup"
  echo "  sudo docker exec -it ${WEBUI_CONTAINER_NAME} /opt/hermes/.venv/bin/hermes config"
  echo
  if [[ -f "${HERMES_DATA_DIR}/hermes-web-ui/.token" ]]; then
    echo "Web UI Token:"
    cat "${HERMES_DATA_DIR}/hermes-web-ui/.token"
    echo
  else
    echo "首次启动 Token 可能还在日志里，查看方式:"
    echo "  cd ${DEPLOY_DIR} && sudo docker compose logs ${WEBUI_CONTAINER_NAME} | grep token"
    echo
  fi
}

DEPLOY_DIR="${DEPLOY_DIR:-/opt/hermes-web-ui}"
PORT="${PORT:-6060}"
AUTH_DISABLED="${AUTH_DISABLED:-false}"
WEBUI_IMAGE="${WEBUI_IMAGE:-ekkoye8888/hermes-web-ui}"
WEBUI_CONTAINER_NAME="${WEBUI_CONTAINER_NAME:-hermes-webui}"
HERMES_DATA_DIR="${HERMES_DATA_DIR:-${DEPLOY_DIR}/hermes_data}"
REPO_REF="${REPO_REF:-main}"
RAW_BASE_URL="${RAW_BASE_URL:-https://raw.githubusercontent.com/EKKOLearnAI/hermes-web-ui/${REPO_REF}}"
ENV_FILE="${DEPLOY_DIR}/.env"
COMPOSE_FILE="${DEPLOY_DIR}/docker-compose.yml"
LOCAL_COMPOSE_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/docker-compose.yml"

echo
echo "hermes / hermes-web-ui 一键部署"
echo "================================"
echo

require_debian_like
require_supported_arch
install_base_packages
install_docker
ensure_docker_running
prepare_dirs
write_env_file
write_compose_file
pull_and_start
wait_for_webui
show_summary
