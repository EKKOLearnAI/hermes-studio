---
name: minimax-image-to-video
description: "Animate an image through Hermes Web UI using the MiniMax image-to-video API."
version: 1.0.0
author: Ekko
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [MiniMax, image-to-video, video-generation, media]
prerequisites:
  commands: [curl]
---

# MiniMax Image To Video

Use this skill when the user wants to animate an image with MiniMax.

If the Hermes Web UI endpoint returns an authentication, connection, or generation error, stop and report that error to the user.

## Workflow

Call the local Hermes Web UI media endpoint. The server resolves MiniMax credentials, creates an image-to-video task, polls it, downloads the finished mp4, and optionally saves it to a requested path.

Endpoint:

```bash
POST <Hermes Web UI base URL>/api/hermes/media/minimax-image-to-video
```

Resolve the Hermes Web UI base URL in this order:

1. `HERMES_WEB_UI_URL`, if set.
2. `http://127.0.0.1:${PORT}`, if `PORT` is set.
3. `http://127.0.0.1:8648`.

Use `http://127.0.0.1:8647` for the development API backend and `http://127.0.0.1:6060` for the default Docker Compose external URL.

Always send the Hermes Web UI server bearer token. Resolve it in this order:

1. `AUTH_TOKEN`, if set.
2. `${HERMES_WEB_UI_HOME}/.token`, if `HERMES_WEB_UI_HOME` is set.
3. `${HERMES_WEBUI_STATE_DIR}/.token`, if `HERMES_WEBUI_STATE_DIR` is set.
4. `~/.hermes-web-ui/.token`.

If the run instructions include `[Current Hermes profile: <name>]`, send the exact profile in `X-Hermes-Profile`. If no profile is provided, omit that header.

Required JSON fields:

- `prompt`: instructions for animating the image when using the default model.
- One image input: `image_url`, `image_base64` with `mime_type`, or `image_path`.

Optional JSON fields:

- `model`: defaults to `MiniMax-H3`; supported v1 image-to-video models may be selected explicitly.
- `duration`: `MiniMax-H3` accepts integer values from 4 through 15 and defaults to 5.
- `resolution`: `MiniMax-H3` uses `2K`.
- `ratio`: defaults to `adaptive`; supported values are `adaptive`, `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, and `9:16`.
- `prompt_optimizer`, `fast_pretreatment`, and `callback_url`: supported request options.
- `aigc_watermark`: optional China-region watermark flag.
- `region`: `global_en` or `cn_zh`.
- `output_path`: local mp4 destination; the server media directory is used when omitted.
- `timeout_ms`: maximum polling time; defaults to 600000.

Example:

```bash
TOKEN="${AUTH_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -n "${HERMES_WEB_UI_HOME:-}" ] && [ -f "$HERMES_WEB_UI_HOME/.token" ]; then
  TOKEN="$(cat "$HERMES_WEB_UI_HOME/.token")"
fi
if [ -z "$TOKEN" ] && [ -n "${HERMES_WEBUI_STATE_DIR:-}" ] && [ -f "$HERMES_WEBUI_STATE_DIR/.token" ]; then
  TOKEN="$(cat "$HERMES_WEBUI_STATE_DIR/.token")"
fi
if [ -z "$TOKEN" ] && [ -f "$HOME/.hermes-web-ui/.token" ]; then
  TOKEN="$(cat "$HOME/.hermes-web-ui/.token")"
fi
if [ -z "$TOKEN" ]; then
  echo "Missing Hermes Web UI token." >&2
  exit 1
fi

BASE_URL="${HERMES_WEB_UI_URL:-http://127.0.0.1:${PORT:-8648}}"
BASE_URL="${BASE_URL%/}"

curl -sS -X POST "$BASE_URL/api/hermes/media/minimax-image-to-video" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "Add a gentle camera push while the clouds drift across the sky",
    "image_url": "https://example.com/source.png",
    "duration": 5,
    "output_path": "/absolute/path/to/output.mp4"
  }'
```

If the response has `code: "missing_minimax_token"`, tell the user to set `MINIMAX_API_KEY` or complete MiniMax authorization before retrying.

Return the generated `output_path`.
