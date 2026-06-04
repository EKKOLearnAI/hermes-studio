#!/usr/bin/env bash
set -Eeuo pipefail

log() {
  printf '[image-export] %s\n' "$*"
}

fail() {
  printf '[image-export] ERROR: %s\n' "$*" >&2
  exit 1
}

require_root() {
  if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
    fail "Please run this script as root."
  fi
}

resolve_root_device() {
  local root_source root_disk
  root_source="$(findmnt -n -o SOURCE / || true)"
  [[ -n "${root_source}" ]] || fail "Cannot resolve root filesystem source."
  root_disk="$(lsblk -no PKNAME "${root_source}" 2>/dev/null | head -n 1 || true)"
  if [[ -n "${root_disk}" ]]; then
    printf '/dev/%s\n' "${root_disk}"
    return 0
  fi
  lsblk -ndo PATH,TYPE | awk '$2 == "disk" { print $1; exit }'
}

require_commands() {
  local missing=()
  local command_name
  for command_name in dd lsblk findmnt sha256sum xz blockdev blkid; do
    if ! command -v "${command_name}" >/dev/null 2>&1; then
      missing+=("${command_name}")
    fi
  done
  if (( ${#missing[@]} > 0 )); then
    fail "Missing required commands: ${missing[*]}"
  fi
}

write_manifest() {
  local manifest_file="$1"
  {
    echo "exported_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "hostname=$(hostname)"
    echo "kernel=$(uname -a)"
    echo "source_disk=${SOURCE_DISK}"
    echo "source_disk_size_bytes=$(blockdev --getsize64 "${SOURCE_DISK}")"
    echo "board_model=$(tr -d '\0' </proc/device-tree/model 2>/dev/null || echo unknown)"
    echo "root_source=$(findmnt -n -o SOURCE / || echo unknown)"
    echo "root_uuid=$(findmnt -n -o UUID / || echo unknown)"
    echo "root_partuuid=$(blkid -s PARTUUID -o value "$(findmnt -n -o SOURCE /)" 2>/dev/null || echo unknown)"
    echo
    echo "[lsblk]"
    lsblk -o NAME,PATH,SIZE,TYPE,FSTYPE,MOUNTPOINT,UUID,PARTUUID
  } > "${manifest_file}"
}

require_root
require_commands

SOURCE_DISK="${SOURCE_DISK:-$(resolve_root_device)}"
OUTPUT_DIR="${OUTPUT_DIR:-/var/tmp/device-images}"
IMAGE_PREFIX="${IMAGE_PREFIX:-$(hostname)-$(date +%Y%m%d-%H%M%S)}"
COMPRESS_IMAGE="${COMPRESS_IMAGE:-1}"

[[ -b "${SOURCE_DISK}" ]] || fail "Source disk does not exist: ${SOURCE_DISK}"

mkdir -p "${OUTPUT_DIR}"

# Check if OUTPUT_DIR is on the root partition to prevent accidental fill-up
ROOT_DEV=$(findmnt -n -o SOURCE /)
TARGET_DEV=$(findmnt -n -o SOURCE -T "${OUTPUT_DIR}")
if [[ "${ROOT_DEV}" == "${TARGET_DEV}" ]]; then
  log "WARNING: OUTPUT_DIR is on the root partition (${ROOT_DEV})."
  log "It is highly recommended to export to an external drive."
  printf "Continue anyway? [y/N] "
  read -r confirm
  [[ "${confirm}" == [yY] ]] || fail "Aborted by user."
fi

MANIFEST_PATH="${OUTPUT_DIR}/${IMAGE_PREFIX}.manifest.txt"
SHA_PATH="${OUTPUT_DIR}/${IMAGE_PREFIX}.sha256"

if [[ "${COMPRESS_IMAGE}" == "1" ]]; then
  IMAGE_PATH="${OUTPUT_DIR}/${IMAGE_PREFIX}.img.xz"
  log "Exporting disk ${SOURCE_DISK} to ${IMAGE_PATH} (Streamed compression)"
  log "This avoids creating a large intermediate .img file."
  dd if="${SOURCE_DISK}" bs=16M status=progress | xz -T0 -c > "${IMAGE_PATH}"
else
  IMAGE_PATH="${OUTPUT_DIR}/${IMAGE_PREFIX}.img"
  log "Exporting disk ${SOURCE_DISK} to ${IMAGE_PATH}"
  dd if="${SOURCE_DISK}" of="${IMAGE_PATH}" bs=16M conv=fsync status=progress
fi

sync
write_manifest "${MANIFEST_PATH}"
sha256sum "${IMAGE_PATH}" > "${SHA_PATH}"

log "Export completed"
log "Image: ${IMAGE_PATH}"
log "Manifest: ${MANIFEST_PATH}"
log "SHA256: ${SHA_PATH}"
