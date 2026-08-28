#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage:
  frame.sh <video-file> [--time HH:MM:SS] [--index N] --out /path/to/frame.jpg

Examples:
  frame.sh video.mp4 --out /tmp/frame.jpg
  frame.sh video.mp4 --time 00:00:10 --out /tmp/frame-10s.jpg
  frame.sh video.mp4 --index 0 --out /tmp/frame0.png
EOF
  exit 2
}

if [[ "${1:-}" == "" || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
fi

input="${1:-}"
shift || true

time=""
index=""
output=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --time)  time="${2:-}"; shift 2 ;;
    --index) index="${2:-}"; shift 2 ;;
    --out)   output="${2:-}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done

if [[ ! -f "$input" ]]; then
  echo "File not found: $input" >&2
  exit 1
fi

if [[ -z "$output" ]]; then
  echo "Missing --out" >&2
  usage
fi

if [[ -n "$time" && -n "$index" ]]; then
  echo "Use either --time or --index, not both" >&2
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg not found in PATH" >&2
  exit 1
fi

mkdir -p "$(dirname "$output")"

if [[ -n "$index" ]]; then
  ffmpeg -hide_banner -loglevel error -y -i "$input" \
    -vf "select=eq(n\\,${index})" -frames:v 1 "$output"
elif [[ -n "$time" ]]; then
  ffmpeg -hide_banner -loglevel error -y -ss "$time" -i "$input" \
    -frames:v 1 "$output"
else
  ffmpeg -hide_banner -loglevel error -y -i "$input" \
    -vf "select=eq(n\\,0)" -frames:v 1 "$output"
fi

echo "$output"
