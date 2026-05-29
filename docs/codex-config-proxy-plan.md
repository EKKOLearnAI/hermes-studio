# Codex Config And Proxy Plan

## Goals

- Launch Codex from Hermes without mutating the user's real `~/.codex`.
- Keep model/provider config isolated by Hermes profile and provider.
- Support OpenAI Responses providers directly.
- Add a local adapter for providers that only expose OpenAI Chat Completions.
- Keep Codex resume/history stable by using a consistent model provider id.

## Directory Layout

All generated Codex state should live under the Web UI home:

```text
~/.hermes-web-ui/coding-agent/
  model/{profile}/{provider}/codex/
    config.toml
    auth.json
    AGENTS.md
  workspace/{profile}/{provider}/
```

Launch command shape:

```bash
cd ~/.hermes-web-ui/coding-agent/workspace/{profile}/{provider} \
  && CODEX_HOME=~/.hermes-web-ui/coding-agent/model/{profile}/{provider}/codex \
  codex --model {model}
```

## Current MVP Config

For Responses-compatible providers, generate:

```toml
model_provider = "custom"
model = "provider-model-id"
disable_response_storage = true

[model_providers.custom]
name = "provider-id"
base_url = "https://provider.example/v1"
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = "provider-api-key"
```

Keep `auth.json` empty for third-party providers:

```json
{}
```

Reason: avoid overwriting the user's official Codex / ChatGPT login cache.

## Stable Provider Id

Use `model_provider = "custom"` for third-party providers.

Codex history and resume behavior can depend on provider identity. Keeping a stable provider id avoids making history appear to move between provider-specific ids.

Provider identity remains visible in:

- `[model_providers.custom].name`
- the generated directory path
- the UI launch result

## Local Proxy Plan

Some providers expose only OpenAI Chat Completions:

```text
/v1/chat/completions
```

Codex prefers Responses:

```text
/v1/responses
```

Add a local proxy endpoint:

```text
/api/codex-proxy/{routeKey}/v1/responses
```

The `routeKey` should encode:

```text
profile + "\0" + provider + "\0" + model
```

Authentication should use a generated `hwui_...` token, not the upstream provider key.

## Responses To Chat Mapping

When the upstream provider is Chat Completions only:

- Convert Responses `input` items to Chat `messages`.
- Convert Responses `tools` to Chat `tools`.
- Convert `max_output_tokens` to `max_tokens`.
- Preserve `stream: true`.
- Map function calls and function outputs both ways.

Response event mapping for streaming:

```text
chat delta.content -> response.output_text.delta
chat delta.tool_calls -> response.function_call_arguments.delta
finish -> response.completed
```

Non-streaming mapping:

```text
chat.choices[0].message.content -> output message/content
chat.choices[0].message.tool_calls -> output function_call items
chat.usage -> response.usage
```

## Config Generation With Proxy

For Chat-only providers, generated Codex config should point at Hermes:

```toml
model_provider = "custom"
model = "provider-model-id"
disable_response_storage = true

[model_providers.custom]
name = "provider-id"
base_url = "http://127.0.0.1:{serverPort}/api/codex-proxy/{routeKey}/v1"
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = "hwui_generated_route_token"
```

The proxy then forwards to the real provider with the real provider key.

## Implementation Tasks

1. Add a Codex proxy service parallel to the Claude Code proxy service.
2. Register route targets in memory for launch-time provider/model selection.
3. Add `/api/codex-proxy/:key/v1/responses`.
4. Implement Responses to Chat conversion.
5. Implement Chat to Responses conversion for streaming and non-streaming.
6. Add launch-time api mode selection for Codex providers.
7. Generate Codex `base_url` against the local proxy when api mode is Chat Completions.
8. Add server tests for config generation, auth rejection, streaming conversion, tool call conversion, and error passthrough.

## Open Questions

- Whether to expose Codex protocol selection in the UI immediately or infer it from provider preset metadata.
- Whether to persist proxy targets or require relaunch after server restart.
- Whether model catalog generation is needed for the first Codex MVP.
- Whether MCP and `AGENTS.md` should be copied from a template or edited only through the advanced config editor.
