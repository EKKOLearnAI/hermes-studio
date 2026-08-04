---
name: minimax-text-to-video
description: "Generate a short video from a text prompt through Hermes Web UI using the MiniMax text-to-video API."
version: 1.0.0
author: Ekko
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [MiniMax, text-to-video, video-generation, media]
prerequisites:
  commands: [curl]
---

# MiniMax Text To Video

Use this skill when the user wants to generate a short video from a text prompt with MiniMax.

Do not use any built-in video generation tool as a fallback. If the Hermes Web UI endpoint returns `401`, `403`, connection failure, or any other error, stop and report the Hermes Web UI error to the user.

## Workflow

Call the local Hermes Web UI media endpoint. The server will check for MiniMax credentials, create a text-to-video generation task, poll until it succeeds, download the generated mp4, and optionally save it locally.

Endpoint:

```bash
POST <Hermes Web UI base URL>/api/hermes/media/minimax-text-to-video
```

Resolve the Hermes Web UI base URL in this order:

1. `HERMES_WEB_UI_URL` environment variable, if set.
2. `http://127.0.0.1:${PORT}`, if `PORT` is set.
3. `http://127.0.0.1:8648` for the Web UI single-server default.

Common local ports:

- Development API backend: `http://127.0.0.1:8647`. Use this with `npm run dev`; do not target the Vite frontend port.
- Web UI single-server default: `http://127.0.0.1:8648`.
- Desktop app default: `http://127.0.0.1:8748`.
- Custom port: set `HERMES_WEB_UI_URL` to the full base URL, or set `PORT` to use `http://127.0.0.1:${PORT}`.

When Hermes Web UI is running from the provided Docker Compose setup, the default external URL is `http://127.0.0.1:6060`.

Authentication:

The endpoint is protected by Hermes Web UI auth. Always send the Hermes Web UI server bearer token. This token is accepted only by Hermes Web UI media generation endpoints for agent skills; it is not a general Web UI login token.

Resolve the token in this order:

1. `AUTH_TOKEN` environment variable, if set.
2. `${HERMES_WEB_UI_HOME}/.token`, if `HERMES_WEB_UI_HOME` is set.
3. `${HERMES_WEBUI_STATE_DIR}/.token`, if `HERMES_WEBUI_STATE_DIR` is set.
4. `~/.hermes-web-ui/.token`.

Profile selection:

Use the current Hermes profile from the run instructions by sending `X-Hermes-Profile`.

If the run instructions include `[Current Hermes profile: <name>]`, include:

```bash
-H "X-Hermes-Profile: <name>"
```

Replace `<name>` with the exact profile name from the run instructions. Never send a placeholder value such as `<name>` or `<current-hermes-profile>`.

If no current profile is provided, omit the header and let the server fall back to the current Hermes active profile.

Required JSON fields:

- `prompt`: a description of the video to generate.

Optional JSON fields:

- `model`: MiniMax text-to-video model. Defaults to `MiniMax-Hailuo-2.3`.
- `duration`: number of seconds for the generated video, if supported by the model.
- `prompt_optimizer`: whether to let the API optimize the prompt.
- `fast_pretreatment`: whether to enable fast preprocessing.
- `resolution`: the desired resolution for the generated video.
- `callback_url`: a callback URL that receives the generation result.
- `region`: `global_en` (default) or `cn_zh` to select the API region.
- `output_path`: local path where the server should save the mp4. If omitted, the server saves to `${HERMES_WEB_UI_HOME:-~/.hermes-web-ui}/media/<task_id>.mp4` and creates the `media` directory if needed.
- `timeout_ms`: maximum wait time. Defaults to 600000.

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
  echo "Missing Hermes Web UI token. Check AUTH_TOKEN, HERMES_WEB_UI_HOME, HERMES_WEBUI_STATE_DIR, or ~/.hermes-web-ui/.token." >&2
  exit 1
fi

BASE_URL="${HERMES_WEB_UI_URL:-}"
if [ -z "$BASE_URL" ]; then
  BASE_URL="http://127.0.0.1:${PORT:-8648}"
fi
BASE_URL="${BASE_URL%/}"

curl -sS -X POST "$BASE_URL/api/hermes/media/minimax-text-to-video" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "A cinematic aerial shot of a mountain lake at sunrise with gentle mist",
    "duration": 5,
    "output_path": "/absolute/path/to/output.mp4"
  }'
```

If the response has `code: "missing_minimax_token"`, tell the user to set `MINIMAX_API_KEY` or complete MiniMax OAuth login in Hermes Web UI before retrying.

Return the generated `output_path`.
