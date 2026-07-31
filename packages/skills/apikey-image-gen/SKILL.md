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

Always call Hermes Web UI's media endpoint. Do not call an upstream image API directly, and do not ask the user for an API key. The server reads the selected/requested profile's `config.yaml` and uses a configured custom provider. By default it uses the provider named `fun-codex`, but callers may request another configured provider by sending `provider`, `provider_name`, or `custom_provider`.

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
  "model": "codex-gpt-image-2",
  "quality": "high",
  "resolution": "4k",
  "aspect": "16:9",
  "output_path": "/absolute/path/to/output.png"
}
```

The server calls `POST /v1/images/generations` against the `fun-codex` base URL.
If `provider`, `provider_name`, or `custom_provider` is present, the server calls the requested provider's base URL instead.

### Image To Image

Use when the user provides a reference image and wants a new image based on it.

```json
{
  "mode": "image",
  "prompt": "Use this reference composition and generate a refined technology brand poster",
  "image_path": "/absolute/path/to/reference.png",
  "quality": "high",
  "resolution": "4k",
  "output_path": "/absolute/path/to/output.png"
}
```

The server calls `POST /v1/responses` against the `fun-codex` base URL.
If `provider`, `provider_name`, or `custom_provider` is present, the server calls the requested provider's base URL instead.

For multiple references, use `references`. Do not combine it with the legacy single-reference fields. Every item must contain exactly one image source, a `role`, and either `priority` (`0`–`100`) or `weight` (`0`–`1`):

```json
{
  "mode": "image",
  "prompt": "Use the first image for composition and the second for visual style",
  "references": [
    {
      "image_path": "/allowed/workspace/layout.png",
      "role": "composition",
      "priority": 1
    },
    {
      "image_base64": "<base64>",
      "mime_type": "image/png",
      "role": "style",
      "weight": 0.8
    }
  ],
  "model": "codex-gpt-image-2",
  "quality": "high",
  "resolution": "4k",
  "aspect": "16:9"
}
```

### Image Edit

Use when the user wants to modify an existing image while preserving parts of it.

```json
{
  "mode": "edit",
  "prompt": "Change the background to blue and keep the subject unchanged",
  "image_path": "/absolute/path/to/source.png",
  "quality": "high",
  "resolution": "4k",
  "output_path": "/absolute/path/to/edited.png"
}
```

The server calls `POST /v1/images/edits` against the `fun-codex` base URL.
If `provider`, `provider_name`, or `custom_provider` is present, the server calls the requested provider's base URL instead.

## Request Fields

- `mode`: `text`, `image`, or `edit`.
- `prompt`: required.
- `provider`: optional configured custom provider name. Defaults to `fun-codex`. `custom:<name>` is accepted and normalized to `<name>`.
- `provider_name`: optional alias for `provider`.
- `custom_provider`: optional alias for `provider`.
- `image_path`: local png, jpeg, or webp path. Required for `image` and `edit` unless using `image_url` or `image_base64`.
- `image_url`: optional alternative image input.
- `image_base64`: optional alternative image input. If it is not a data URI, include `mime_type`.
- `references`: optional structured array for `image` and `edit` modes. Maximum 8 items. Each item accepts exactly one of `image_path`, `image_url`, or `image_base64`, plus `role` and either `priority` or `weight`.
- `n`: number of images. Defaults to `1`.
- `size`: optional legacy provider size parameter. It is forwarded only; Hermes Studio never locally resizes an image to satisfy it.
- `quality`: defaults to `high`.
- `resolution`: defaults to `4k` and is passed to the provider. Hermes Studio does not upscale a smaller provider result.
- `aspect` / `aspect_ratio`: provider aspect-ratio parameter. Defaults to `auto`.
- `model`: optional override. Text/edit modes default to `codex-gpt-image-2`; in image mode it continues to select the Responses orchestration model.
- `image_model`: optional image tool model for image mode. Defaults to `codex-gpt-image-2`.
- `output_format`: `png`, `jpeg`, or `webp`. Defaults to `png`.
- `output_path`: optional output file path under an allowed Web UI, upload, workspace/user, or temporary root. If omitted, the server saves to `${HERMES_WEB_UI_HOME:-~/.hermes-web-ui}/media/*`.
- `timeout_ms`: defaults to `600000`.

Validation limits:

- Only PNG, JPEG, and WebP are accepted. The declared MIME must match the image signature.
- Structured references are limited to 10 MiB each and 12 MiB decoded in total.
- Generated images are limited to 50 MiB each and 100 MiB per provider response.
- The JSON request is limited to 18 MiB. The server's global JSON parser remains capped at 20 MiB.
- Public HTTP(S) reference URLs must not resolve to loopback, private, link-local, or credential-bearing targets; redirects are revalidated.
- Local reference and output paths must remain under the allowed roots. Set `WORKSPACE_BASE` when a deployment needs a narrower workspace root.

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
    "provider": "fun-codex",
    "prompt": "A cinematic 4K photo of a silver robot hand holding a small glowing cube",
    "model": "codex-gpt-image-2",
    "quality": "high",
    "resolution": "4k",
    "aspect": "16:9",
    "output_path": "/absolute/path/to/output.png"
  }'
```

Successful responses include:

```json
{
  "ok": true,
  "mode": "text",
  "output_paths": ["/absolute/path/to/output.png"],
  "provider": "fun-codex",
  "base_url": "https://api.apikey.fun/v1",
  "request_id": "6ca4b37c-8e06-4bd9-a4ee-6f77b8106fbf",
  "model": "codex-gpt-image-2",
  "actual_model": "codex-gpt-image-2",
  "actual_provider": "fun-codex",
  "quality": "high",
  "resolution": "4k",
  "aspect": "16:9",
  "dimensions": {
    "width": 3840,
    "height": 2160
  },
  "format": "png",
  "images": [
    {
      "output_path": "/absolute/path/to/output.png",
      "dimensions": {
        "width": 3840,
        "height": 2160
      },
      "format": "png"
    }
  ]
}
```

If the response code is `missing_fun_codex_provider`, tell the user to configure `fun-codex` in the selected/requested profile's `config.yaml`.
If the response code is `missing_apikey_image_provider`, tell the user to configure the requested provider in the selected/requested profile's `config.yaml`, or omit `provider` to use the default `fun-codex` provider.
Validation failures use stable codes such as `too_many_references`, `reference_too_large`, `references_total_too_large`, `unsupported_reference_mime`, `reference_mime_mismatch`, `unsafe_reference_path`, and `unsafe_reference_url`.
Provider failures use `upstream_auth_failed`, `upstream_rejected_request`, `upstream_rate_limited`, `upstream_timeout`, `upstream_invalid_response`, or `upstream_unavailable`. Error bodies never include upstream response text, credentials, Authorization headers, private paths, or image data.
