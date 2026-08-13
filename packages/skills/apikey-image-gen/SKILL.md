---
name: apikey-image-gen
description: "Generate or edit images through Hermes Web UI using the selected/requested profile's configured API-key image provider from config.yaml."
version: 1.0.0
author: Ekko
license: MIT
platforms: [linux, macos, windows, termux]
metadata:
  hermes:
    tags: [api.apikey.fun, custom-provider, image-generation, image-editing, media]
prerequisites:
  commands: [curl]
---

# APIKEY Image Generation

Use this skill when the user wants to generate an image, generate an image from a reference image, or edit an existing image.

Always call Hermes Web UI's media endpoint. Do not call an upstream image API directly, and do not ask the user for an API key. The server reads the selected/requested profile's configuration. By default it uses the custom provider named `fun-codex`; `provider: minimax` and `provider: minimax-cn` use the profile's built-in MiniMax credentials for the global and China endpoints.

Do not use any built-in image generation tool as a fallback. If the Hermes Web UI endpoint returns `401`, `403`, connection failure, or any other error, stop and report the Hermes Web UI error to the user.

```yaml
custom_providers:
  - name: fun-codex
    base_url: https://api.apikey.fun/v1
    api_key: ...
    model: gpt-5.5
    api_mode: codex_responses
```

Example with another configured provider:

```yaml
custom_providers:
  - name: agnes
    base_url: https://agnes.example/v1
    api_key_env: AGNES_API_KEY
    model: agnes-image-2.1-flash
```

Endpoint:

```bash
POST <Hermes Web UI base URL>/api/hermes/media/apikey-image-generate
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

When Hermes Web UI is running from Docker Compose, the default external URL is `http://127.0.0.1:6060`.

Authentication:

Send the Hermes Web UI server bearer token. This token is accepted only by Hermes Web UI media generation endpoints for agent skills; it is not a general Web UI login token.

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

## Modes

### Text To Image

Use when there is no input image.

```json
{
  "mode": "text",
  "prompt": "A high quality product image of a matte black mechanical keyboard on a clean desk",
  "size": "1024x1024",
  "output_path": "/absolute/path/to/output.png"
}
```

The server calls `POST /v1/images/generations` against the `fun-codex` base URL.
If `provider`, `provider_name`, or `custom_provider` is present, the server calls the requested provider's base URL instead.

For MiniMax text-to-image generation, use:

```json
{
  "mode": "text",
  "provider": "minimax",
  "model": "image-01",
  "prompt": "A high quality product image of a matte black mechanical keyboard on a clean desk",
  "aspect_ratio": "1:1",
  "response_format": "base64",
  "n": 1,
  "prompt_optimizer": true,
  "output_path": "/absolute/path/to/output.png"
}
```

The server calls `POST https://api.minimax.io/v1/image_generation` for `minimax` and `POST https://api.minimaxi.com/v1/image_generation` for `minimax-cn`.

### Image To Image

Use when the user provides a reference image and wants a new image based on it.

```json
{
  "mode": "image",
  "prompt": "Use this reference composition and generate a refined technology brand poster",
  "image_path": "/absolute/path/to/reference.png",
  "size": "1024x1024",
  "output_path": "/absolute/path/to/output.png"
}
```

The server calls `POST /v1/responses` against the `fun-codex` base URL.
If `provider`, `provider_name`, or `custom_provider` is present, the server calls the requested provider's base URL instead.

For MiniMax reference-image generation, use `mode: image`. You may send `subject_reference` directly, or send `image_path`, `image_url`, or `image_base64`; the server converts the latter forms to a `character` subject reference.

```json
{
  "mode": "image",
  "provider": "minimax",
  "model": "image-01-live",
  "prompt": "Create a polished editorial portrait using the reference subject",
  "subject_reference": [
    {
      "type": "character",
      "image_file": "https://example.com/reference.png"
    }
  ],
  "aspect_ratio": "3:4",
  "response_format": "url",
  "output_path": "/absolute/path/to/output.png"
}
```

### Image Edit

Use when the user wants to modify an existing image while preserving parts of it.

```json
{
  "mode": "edit",
  "prompt": "Change the background to blue and keep the subject unchanged",
  "image_path": "/absolute/path/to/source.png",
  "size": "1024x1024",
  "output_path": "/absolute/path/to/edited.png"
}
```

The server calls `POST /v1/images/edits` against the `fun-codex` base URL.
If `provider`, `provider_name`, or `custom_provider` is present, the server calls the requested provider's base URL instead.

## Request Fields

- `mode`: `text`, `image`, or `edit`.
- `prompt`: required.
- `provider`: optional provider name. Defaults to `fun-codex`. Use `minimax` for the global MiniMax endpoint or `minimax-cn` for the China endpoint. `custom:<name>` is accepted and normalized to `<name>`.
- `provider_name`: optional alias for `provider`.
- `custom_provider`: optional alias for `provider`.
- `image_path`: local png, jpeg, or webp path. Required for `image` and `edit` unless using `image_url` or `image_base64`.
- `image_url`: optional alternative image input.
- `image_base64`: optional alternative image input. If it is not a data URI, include `mime_type`.
- `n`: number of images. Defaults to `1`.
- `size`: defaults to `1024x1024`. Common values: `1024x1024`, `1536x1024`, `1024x1536`, `2048x2048`, `3840x2160`, `2160x3840`, `auto`.
- `quality`: defaults to `auto`.
- `model`: optional override. MiniMax defaults to `image-01` and also supports `image-01-live`; non-MiniMax modes retain their existing defaults.
- `image_model`: optional image tool model for image mode. Defaults to `gpt-image-2`.
- `subject_reference`: MiniMax subject references. Each entry requires `type` and `image_file`; `image_file` may be a public URL or an image Data URL.
- `aspect_ratio`: optional MiniMax output ratio.
- `width` and `height`: optional MiniMax pixel dimensions.
- `response_format`: MiniMax output format, `url` or `base64`. URL results expire after 24 hours, so the server downloads them immediately before saving.
- `seed`: optional MiniMax random seed.
- `prompt_optimizer`: optional MiniMax prompt optimization flag.
- `output_path`: optional absolute output file path. If omitted, the server saves to `${HERMES_WEB_UI_HOME:-~/.hermes-web-ui}/media/*.png`.
- `timeout_ms`: defaults to `600000`.

## Curl Template

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

curl -sS -X POST "$BASE_URL/api/hermes/media/apikey-image-generate" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "mode": "text",
    "provider": "minimax",
    "model": "image-01",
    "prompt": "A cinematic 4K photo of a silver robot hand holding a small glowing cube",
    "aspect_ratio": "16:9",
    "response_format": "base64",
    "output_path": "/absolute/path/to/output.png"
  }'
```

Successful responses include:

```json
{
  "ok": true,
  "mode": "text",
  "output_paths": ["/absolute/path/to/output.png"],
  "provider": "minimax",
  "base_url": "https://api.minimax.io/v1/image_generation",
  "metadata": {
    "success_count": 1,
    "failed_count": 0
  }
}
```

If the response code is `missing_fun_codex_provider`, tell the user to configure `fun-codex` in the selected/requested profile's `config.yaml`.
If the response code is `missing_apikey_image_provider`, tell the user to configure the requested provider in the selected/requested profile's `config.yaml`, or omit `provider` to use the default `fun-codex` provider.
If the response code is `missing_minimax_image_provider`, tell the user to configure the MiniMax API key for the selected/requested profile.

MiniMax API references:

- Global text-to-image: https://platform.minimax.io/docs/api-reference/image-generation-t2i
- Global reference-image: https://platform.minimax.io/docs/api-reference/image-generation-i2i
- China text-to-image: https://platform.minimaxi.com/docs/api-reference/image-generation-t2i
- China reference-image: https://platform.minimaxi.com/docs/api-reference/image-generation-i2i
