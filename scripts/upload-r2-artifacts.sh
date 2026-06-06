#!/usr/bin/env bash
set -euo pipefail

: "${R2_ACCOUNT_ID:?Missing R2_ACCOUNT_ID}"
: "${R2_BUCKET:?Missing R2_BUCKET}"
: "${R2_PREFIX:?Missing R2_PREFIX}"
: "${R2_FILES:?Missing R2_FILES}"

endpoint="${R2_ENDPOINT_URL:-https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com}"
cache_control="${R2_CACHE_CONTROL:-public, max-age=3600}"
prefix="${R2_PREFIX#/}"
prefix="${prefix%/}"
uploaded=0

shopt -s nullglob

while IFS= read -r pattern; do
  [ -n "$pattern" ] || continue
  matches=( $pattern )
  if [ "${#matches[@]}" -eq 0 ]; then
    echo "No files matched R2 upload pattern: ${pattern}" >&2
    exit 1
  fi

  for file in "${matches[@]}"; do
    [ -f "$file" ] || continue
    name="$(basename "$file")"
    aws s3 cp "$file" "s3://${R2_BUCKET}/${prefix}/${name}" \
      --endpoint-url "$endpoint" \
      --cache-control "$cache_control"
    uploaded=$((uploaded + 1))
  done
done <<< "$R2_FILES"

if [ "$uploaded" -eq 0 ]; then
  echo "No files were uploaded to R2." >&2
  exit 1
fi

echo "Uploaded ${uploaded} file(s) to r2://${R2_BUCKET}/${prefix}/"
