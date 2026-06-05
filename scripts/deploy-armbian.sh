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

trap 'err "Deployment failed at line: $LINENO"' ERR

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

trim_whitespace() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

python_cmd() {
  if command_exists python3; then
    echo "python3"
    return 0
  fi
  if command_exists python; then
    echo "python"
    return 0
  fi
  return 1
}

compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    echo "docker compose"
    return 0
  fi
  if command_exists docker-compose; then
    echo "docker-compose"
    return 0
  fi
  return 1
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
    aarch64|arm64|x86_64|amd64)
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
    gnupg \
    lsb-release \
    apt-transport-https \
    software-properties-common
}

cleanup_docker_official_repo() {
  warn "Cleaning up Docker official repository configuration"
  run rm -f /etc/apt/sources.list.d/docker.list
  run rm -f /etc/apt/keyrings/docker.asc
}

install_docker_from_system_repo() {
  step "Install Docker from the system repository"
  apt_update
  if run apt-get install -y docker.io docker-compose-v2; then
    info "Installed docker.io + docker-compose-v2 from the system repository"
    return 0
  fi

  warn "docker-compose-v2 installation failed. Trying docker-compose-plugin."
  if run apt-get install -y docker.io docker-compose-plugin; then
    info "Installed docker.io + docker-compose-plugin from the system repository"
    return 0
  fi

  warn "docker-compose-plugin installation failed. Trying legacy docker-compose."
  run apt-get install -y docker.io docker-compose
  info "Installed docker.io + docker-compose from the system repository"
}

install_docker_from_official_repo() {
  cleanup_docker_official_repo
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
}

install_docker() {
  if command_exists docker && compose_cmd >/dev/null 2>&1; then
    info "Docker and Docker Compose are already installed. Skipping installation."
    return
  fi

  step "Install Docker and the Docker Compose plugin"

  if install_docker_from_official_repo; then
    run systemctl enable --now docker
    info "Docker installation from the official repository completed."
    return
  fi

  warn "Docker installation from the official repository failed. Falling back to the system repository."
  cleanup_docker_official_repo
  install_docker_from_system_repo

  run systemctl enable --now docker
  info "Docker installation completed."
}

ensure_docker_running() {
  step "Check Docker service status"
  run systemctl enable --now docker
  run docker version >/dev/null
  if ! compose_cmd >/dev/null 2>&1; then
    err "Docker Compose is not available. Check the Docker installation."
    exit 1
  fi
  info "Docker service is running."
}

update_docker_registry_mirrors_config() {
  local mirror_csv="$1"
  local daemon_file python_bin
  daemon_file="/etc/docker/daemon.json"
  python_bin="$(python_cmd || true)"

  if [[ -z "$python_bin" ]]; then
    warn "python3/python is not available. Cannot safely update daemon.json."
    return 1
  fi

  run install -m 0755 -d /etc/docker
  if [[ ! -f "$daemon_file" ]]; then
    run tee "$daemon_file" >/dev/null <<EOF
{}
EOF
  fi

  run env MIRROR_CSV="$mirror_csv" DAEMON_FILE="$daemon_file" "$python_bin" - <<'PY'
import json
import os
import pathlib
import sys

daemon_path = pathlib.Path(os.environ["DAEMON_FILE"])
mirror_csv = os.environ["MIRROR_CSV"]
mirrors = [item.strip() for item in mirror_csv.split(",") if item.strip()]

try:
    current = json.loads(daemon_path.read_text(encoding="utf-8"))
    if not isinstance(current, dict):
        raise ValueError("daemon.json root is not an object")
except FileNotFoundError:
    current = {}
except Exception as exc:
    print(f"Failed to parse {daemon_path}: {exc}", file=sys.stderr)
    sys.exit(1)

if mirrors:
    if current.get("registry-mirrors") == mirrors:
        sys.exit(0)
    current["registry-mirrors"] = mirrors
else:
    if "registry-mirrors" not in current:
        sys.exit(0)
    current.pop("registry-mirrors", None)

daemon_path.write_text(
    json.dumps(current, ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
)
PY
}

docker_registry_mirror_healthy() {
  local mirror="$1"
  local probe_url http_code
  probe_url="${mirror%/}/v2/"
  http_code="$(curl -k -sS -o /dev/null --connect-timeout 5 --max-time 8 -w '%{http_code}' "$probe_url" || true)"
  case "$http_code" in
    200|401|404)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

disable_docker_registry_mirrors() {
  local reason="${1:-The current Docker registry mirror is unavailable. Falling back to direct docker.io access.}"

  if [[ "${DOCKER_REGISTRY_MIRRORS_DISABLED}" == "1" ]]; then
    info "Direct docker.io mode is already active. Skipping duplicate switch."
    return 0
  fi

  warn "$reason"
  if ! update_docker_registry_mirrors_config ""; then
    warn "Failed to remove Docker registry-mirrors. Keeping the current Docker configuration."
    return 1
  fi

  run systemctl restart docker
  DOCKER_REGISTRY_MIRRORS_DISABLED=1
  ACTIVE_DOCKER_REGISTRY_MIRRORS=""
  info "Removed Docker registry-mirrors and switched back to direct docker.io access"
}

configure_docker_registry_mirrors() {
  step "Configure Docker registry mirrors"

  local mirror_csv
  local candidate
  local -a requested_mirrors=()
  local -a healthy_mirrors=()

  mirror_csv="${DOCKER_REGISTRY_MIRRORS:-https://hub-mirror.c.163.com}"
  if [[ -z "${mirror_csv// }" ]]; then
    warn "No Docker registry mirror was provided. Keeping direct docker.io access."
    disable_docker_registry_mirrors "No Docker registry mirror was configured. Keeping direct docker.io access." || true
    return 0
  fi

  IFS=',' read -r -a requested_mirrors <<< "$mirror_csv"
  for candidate in "${requested_mirrors[@]}"; do
    candidate="$(trim_whitespace "$candidate")"
    if [[ -z "$candidate" ]]; then
      continue
    fi

    if docker_registry_mirror_healthy "$candidate"; then
      healthy_mirrors+=("$candidate")
    else
      warn "Skipping unavailable Docker registry mirror: $candidate"
    fi
  done

  if [[ ${#healthy_mirrors[@]} -eq 0 ]]; then
    disable_docker_registry_mirrors "All configured Docker registry mirrors are unavailable. Falling back to direct docker.io access." || true
    return 0
  fi

  ACTIVE_DOCKER_REGISTRY_MIRRORS="$(IFS=,; echo "${healthy_mirrors[*]}")"
  if ! update_docker_registry_mirrors_config "${ACTIVE_DOCKER_REGISTRY_MIRRORS}"; then
    warn "Failed to update the Docker registry mirror configuration. Keeping the current Docker configuration."
    return 0
  fi

  run systemctl restart docker
  DOCKER_REGISTRY_MIRRORS_DISABLED=0
  info "Configured Docker registry mirrors: ${ACTIVE_DOCKER_REGISTRY_MIRRORS}"
}

compose_pull() {
  local compose="$1"
  if [[ "$compose" == "docker compose" ]]; then
    run docker compose pull
    return
  fi
  run docker-compose pull
}

compose_build_webui() {
  local compose="$1"
  if [[ "$compose" == "docker compose" ]]; then
    run docker compose build hermes-webui
    return
  fi
  run docker-compose build hermes-webui
}

compose_up_detached() {
  local compose="$1"
  if [[ "$compose" == "docker compose" ]]; then
    run docker compose up -d
    return
  fi
  run docker-compose up -d
}

pull_or_build_webui() {
  local compose="$1"

  if compose_pull "$compose"; then
    return 0
  fi

  warn "Failed to pull the prebuilt image. Retrying after disabling Docker registry mirrors."
  if disable_docker_registry_mirrors "Image pull failed. Removing possibly broken Docker registry mirrors." \
    && compose_pull "$compose"; then
    return 0
  fi

  warn "Pulling the prebuilt image still failed. Trying a local hermes-webui build."
  if compose_build_webui "$compose"; then
    return 0
  fi

  warn "Local build failed. Retrying hermes-webui build in direct docker.io mode."
  disable_docker_registry_mirrors "Base image pull failed. Confirming that direct docker.io mode is active." || true
  compose_build_webui "$compose"
}

prepare_dirs() {
  step "Prepare deployment directories"
  run mkdir -p "${DEPLOY_DIR}" "${HERMES_DATA_DIR}" "${HERMES_DATA_DIR}/hermes-web-ui"
  info "Deployment directory: ${DEPLOY_DIR}"
  info "Data directory: ${HERMES_DATA_DIR}"
}

write_env_file() {
  step "Write deployment environment file"
  run tee "${ENV_FILE}" >/dev/null <<EOF
WEBUI_IMAGE=${WEBUI_IMAGE}
WEBUI_CONTAINER_NAME=${WEBUI_CONTAINER_NAME}
PORT=${PORT}
AUTH_DISABLED=${AUTH_DISABLED}
HERMES_DATA_DIR=${HERMES_DATA_DIR}
EOF
  info "Wrote ${ENV_FILE}"
}

write_compose_file() {
  step "Write docker-compose.yml"
  if [[ -f "${LOCAL_COMPOSE_FILE}" ]]; then
    if [[ "${LOCAL_COMPOSE_FILE}" == "${COMPOSE_FILE}" ]]; then
      info "The current directory is already the deployment directory. Reusing the existing docker-compose.yml."
      return
    fi
    run cp "${LOCAL_COMPOSE_FILE}" "${COMPOSE_FILE}"
    info "Copied docker-compose.yml from the local repository"
    return
  fi

  curl -fsSL "${RAW_BASE_URL}/docker-compose.yml" | run tee "${COMPOSE_FILE}" >/dev/null
  info "Downloaded docker-compose.yml from the remote source"
}

pull_and_start() {
  step "Pull and start the hermes-web-ui container"
  local compose
  compose="$(compose_cmd)"
  (
    cd "${DEPLOY_DIR}"
    pull_or_build_webui "$compose"
    compose_up_detached "$compose"
  )
  info "Container started."
}

wait_for_webui() {
  step "Wait for the Web UI to become ready"
  local url="http://127.0.0.1:${PORT}/health"
  local attempts=60
  local i
  for ((i = 1; i <= attempts; i++)); do
    if curl -fsSL --max-time 5 "${url}" >/dev/null 2>&1; then
      info "Web UI is reachable: ${url}"
      return
    fi
    sleep 2
  done
  warn "Web UI health check timed out. You can retry later with: curl ${url}"
}

show_summary() {
  local compose
  compose="$(compose_cmd || echo 'docker compose')"
  echo
  info "Deployment completed"
  echo "----------------------------------------"
  echo "Server URL: http://$(hostname -I 2>/dev/null | awk '{print $1}'):${PORT}"
  echo "Local URL: http://127.0.0.1:${PORT}"
  echo "Deployment directory: ${DEPLOY_DIR}"
  echo "Data directory: ${HERMES_DATA_DIR}"
  echo
  echo "Common commands:"
  echo "  cd ${DEPLOY_DIR} && sudo ${compose} ps"
  echo "  cd ${DEPLOY_DIR} && sudo ${compose} logs -f ${WEBUI_CONTAINER_NAME}"
  echo "  cd ${DEPLOY_DIR} && sudo ${compose} restart"
  echo "  cd ${DEPLOY_DIR} && sudo ${compose} down"
  echo
  echo "Manual Hermes setup:"
  echo "  sudo docker exec -it ${WEBUI_CONTAINER_NAME} /opt/hermes/.venv/bin/hermes setup"
  echo "  sudo docker exec -it ${WEBUI_CONTAINER_NAME} /opt/hermes/.venv/bin/hermes config"
  echo
  if [[ -f "${HERMES_DATA_DIR}/hermes-web-ui/.token" ]]; then
    echo "Web UI Token:"
    cat "${HERMES_DATA_DIR}/hermes-web-ui/.token"
    echo
  else
    echo "If the first-start token is not on disk yet, check the logs with:"
    echo "  cd ${DEPLOY_DIR} && sudo ${compose} logs ${WEBUI_CONTAINER_NAME} | grep token"
    echo
  fi
}

DEPLOY_DIR="${DEPLOY_DIR:-/opt/hermes-web-ui}"
PORT="${PORT:-6060}"
AUTH_DISABLED="${AUTH_DISABLED:-false}"
WEBUI_IMAGE="${WEBUI_IMAGE:-ekkoye8888/hermes-web-ui}"
WEBUI_CONTAINER_NAME="${WEBUI_CONTAINER_NAME:-hermes-webui}"
HERMES_DATA_DIR="${HERMES_DATA_DIR:-${DEPLOY_DIR}/hermes_data}"
DOCKER_REGISTRY_MIRRORS="${DOCKER_REGISTRY_MIRRORS:-https://hub-mirror.c.163.com}"
ACTIVE_DOCKER_REGISTRY_MIRRORS=""
DOCKER_REGISTRY_MIRRORS_DISABLED=0
REPO_REF="${REPO_REF:-main}"
RAW_BASE_URL="${RAW_BASE_URL:-https://raw.githubusercontent.com/EKKOLearnAI/hermes-web-ui/${REPO_REF}}"
ENV_FILE="${DEPLOY_DIR}/.env"
COMPOSE_FILE="${DEPLOY_DIR}/docker-compose.yml"
LOCAL_COMPOSE_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/docker-compose.yml"

echo
echo "hermes / hermes-web-ui deployment"
echo "================================"
echo

require_debian_like
require_supported_arch
install_base_packages
install_docker
configure_docker_registry_mirrors
ensure_docker_running
prepare_dirs
write_env_file
write_compose_file
pull_and_start
wait_for_webui
show_summary
