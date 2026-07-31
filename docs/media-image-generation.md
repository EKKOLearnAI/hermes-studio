# API-key Image Generation Contract

`POST /api/hermes/media/apikey-image-generate` supports text-to-image, image-to-image, and edit requests through an existing configured custom provider. Provider catalog lookup, base URL selection, and API-key or API-key-environment resolution remain profile-scoped; this contract adds no OAuth flow and has no built-in upstream URL or token.

## Compatibility and multi-reference input

Existing `image_path`, `image_url`, and `image_base64` requests remain valid as a single reference for `image` and `edit` modes. New clients can send up to eight `references`; every item supplies exactly one of those image sources, a non-empty `role`, and either integer `priority` from 0 through 100 or numeric `weight` from 0 through 1. Do not combine `references` with the legacy top-level image fields.

The service forwards reference roles and responsibility metadata to the configured provider. Image-mode requests carry the metadata beside each Responses `input_image`; edit-mode multipart requests carry indexed role, priority, and weight fields.

The native generation defaults are `model=codex-gpt-image-2`, `quality=high`, and `resolution=4k`. `provider`, `model`, `image_model`, `quality`, `resolution`, `aspect`/`aspect_ratio`, legacy `size`, and `output_format` can be set explicitly. These values are forwarded upstream. Hermes Studio does not resize or upscale provider output; returned `dimensions` describe the original decoded provider image.

The existing success fields (`ok`, `mode`, `output_paths`, `provider`, `base_url`, and `profile`) remain. Additive fields identify `request_id`, actual `model`/`provider`, requested quality/resolution/aspect, original dimensions and format, plus per-image metadata.

## Limits and security

- The JSON contract limit is 18 MiB, below the server-wide 20 MiB parser limit.
- A structured reference is limited to 10 MiB decoded, all references to 12 MiB decoded, and the array to eight entries.
- Provider output is limited to 50 MiB per image and 100 MiB per response.
- PNG, JPEG, and WebP are accepted. MIME declarations and URL content types must match image signatures.
- Local inputs and outputs must remain under the Web UI home, upload root, configured `WORKSPACE_BASE` (or the user home fallback), current workspace, or system temporary root. Real paths are checked to prevent symlink escapes.
- Remote references must use public HTTP(S), contain no URL credentials, and must not resolve to private, loopback, link-local, multicast, or reserved addresses. Redirects are manually limited and revalidated.
- Upstream response text is never copied into client errors. Stable codes distinguish validation, provider authentication, rejection, rate limit, timeout, invalid response, and availability failures.

## Deployment impact

No database migration, OAuth registration, new credential, or new provider route is required. Existing custom-provider entries continue to supply `base_url`, `api_key`/`api_key_env`, and provider model configuration.

Deploy the server and bundled `apikey-image-gen` skill documentation together. A normal process restart is required for server code changes to take effect; this change does not require restarting an upstream provider. Ensure the runtime user can write its Web UI media directory and any explicitly allowed workspace output directory. If callers previously used local paths outside the allowed roots or private-network image URLs, move those images into the upload/workspace roots or update `WORKSPACE_BASE`; these requests are intentionally rejected after deployment.

The larger native 4K results and multi-reference payloads increase provider latency, response bandwidth, temporary memory, and media-disk use. Reverse proxies should allow request bodies up to the existing 20 MiB application limit and timeouts at least as long as the chosen `timeout_ms`. Do not add an image resizing proxy as a substitute for provider-native 4K output.

URL validation rejects private DNS answers before each fetch and revalidates every redirect. DNS resolution and the HTTP connection are separate operations, so deployments with hostile or untrusted DNS should also enforce outbound network policy at the container or host boundary to close DNS-rebinding time-of-check/time-of-use windows.
