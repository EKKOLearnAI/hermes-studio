# Grok Image To Video

Use this skill when the user wants to animate a local image into a short video with xAI Grok Imagine.

## Workflow

Call the local Hermes Web UI media endpoint. Pass a local image path; the server will check for xAI credentials, read the file, convert it to a base64 data URI, call xAI, poll until completion, and optionally save the generated mp4.

Endpoint:

```bash
POST http://localhost:8648/api/hermes/media/grok-image-to-video
```

Authentication:

The endpoint is protected by Hermes Web UI auth. Always send the Web UI bearer token.

Resolve the token in this order:

1. `AUTH_TOKEN` environment variable, if set.
2. `${HERMES_WEB_UI_HOME}/.token`, if `HERMES_WEB_UI_HOME` is set.
3. `${HERMES_WEBUI_STATE_DIR}/.token`, if `HERMES_WEBUI_STATE_DIR` is set.
4. `~/.hermes-web-ui/.token`.

Required JSON fields:

- `image_path`: local path to a png, jpeg, or webp image.
- `prompt`: motion and style instructions for the generated video.

Optional JSON fields:

- `duration`: seconds, 1 to 15. Defaults to 8.
- `output_path`: local path where the server should save the mp4. If omitted, the server saves to `${HERMES_WEB_UI_HOME:-~/.hermes-web-ui}/media/<request_id>.mp4` and creates the `media` directory if needed.
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

curl -sS -X POST http://localhost:8648/api/hermes/media/grok-image-to-video \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "image_path": "/absolute/path/to/input.png",
    "prompt": "Animate the subject with a slow cinematic push-in and subtle natural motion.",
    "duration": 8,
    "output_path": "/absolute/path/to/output.mp4"
  }'
```

If the response has `code: "missing_xai_token"`, tell the user to set `XAI_API_KEY` or complete xAI OAuth login in Hermes Web UI before retrying.

Return the generated `output_path`.
