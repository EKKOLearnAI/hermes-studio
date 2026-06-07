# Agent Runner Implementation Notes

This file tracks implementation decisions before code is moved into this
directory.

## Proposed Public Interfaces

```ts
export type AgentApiMode =
  | 'chat_completions'
  | 'codex_responses'
  | 'anthropic_messages'

export interface AgentTarget {
  routeKey: string
  token: string
  profile?: string
  sessionId?: string
  provider: string
  model: string
  baseUrl: string
  apiKey: string
  apiMode: AgentApiMode
}

export interface AgentRunRequest {
  target: AgentTarget
  protocol: 'responses' | 'anthropic_messages'
  body: unknown
  stream: boolean
  sessionId?: string
  profile?: string
  abortSignal?: AbortSignal
}

export interface CanonicalAgentEvent {
  type: string
  data: Record<string, unknown>
}
```

The concrete implementation can adjust names, but the important boundary is:
routes pass request details in, and receive canonical events or a complete
canonical response out.

## Suggested File Layout

```txt
agent-runner/
  README.md
  IMPLEMENTATION_NOTES.md
  target-registry.ts
  endpoint-resolver.ts
  sse.ts
  gateway.ts
  adapters/
    anthropic-messages.ts
    chat-completions.ts
    responses.ts
  serializers/
    anthropic-sse.ts
    responses-sse.ts
  subscribers/
    persistence.ts
    socket-events.ts
```

## First Code Move

The first safe code move should be utility extraction only:

- `authToken`
- `readProviderJson`
- `throwProviderError`
- endpoint URL builders
- SSE frame parsing

This keeps behavior unchanged and gives tests a small target.

Done:

- Shared target registry is in `target-registry.ts`.
- Shared endpoint resolver is in `endpoint-resolver.ts`.
- Shared SSE helpers are in `sse.ts`.
- Claude and Codex proxy implementations now live under `proxies/`.
- Codex non-streaming Responses adapters are in `adapters/responses.ts`.
- Codex streaming Responses adapters are in `adapters/responses-stream.ts`.
- Claude non-streaming Anthropic adapters are in `adapters/anthropic.ts`.
- Claude streaming Anthropic adapters are in `adapters/anthropic-stream.ts`.
- Shared provider target resolution for internal runs is in `run-target.ts`.
- Shared provider stream routing for internal runs is in `run-stream.ts`.
- `handleApiRun` consumes canonical Responses events from the gateway and keeps
  the existing session persistence path.

## Current Boundary

Gateway adoption is complete for the current proxy and internal API-run paths:

- Claude and Codex proxy route handlers are still responsible for local auth,
  Koa response shape, and target lookup.
- `AgentRunGateway` is responsible for upstream POSTs, bearer auth, stream
  validation, and provider error shape.
- `run-stream.ts` is responsible for choosing the provider protocol and
  returning canonical Responses events to Web UI runs.
- Keep persistence optional and disabled for external proxy requests unless a
  session binding is provided.

The next safe extraction is a persistence subscriber for external proxy request
session binding. Internal Web UI runs already persist through
`run-chat/response-stream.ts`.

## Compatibility Notes

- Claude Code expects Anthropic-shaped errors and Messages SSE events.
- Codex expects OpenAI/Responses-shaped errors and Responses SSE events.
- Some OpenAI-compatible providers expect `/v1/chat/completions`.
- Some providers already include a non-`/v1` OpenAI root path in `baseUrl`.
- The endpoint resolver must use tests from provider presets, not only regexes.

## Persistence Notes

The existing `messages` table can represent:

- user messages
- assistant text
- assistant tool calls through `tool_calls`
- tool results through `tool_call_id` and `tool_name`
- reasoning through `reasoning` and `reasoning_content`

No schema change is needed for the first implementation.

## Open Questions

- Should launched Claude/Codex proxy targets always bind to a Web UI session, or
  only when a session is already active?
- Should proxy-run persistence store the launched tool name (`claude-code` or
  `codex`) in `source`, or keep source as `api_server` and rely on provider?
- How should external proxy aborts be exposed to Web UI clients if the request
  did not originate from a Web UI socket?
