# Ekko Agent

Ekko Agent is a standalone TypeScript agent runtime used by Hermes Studio. It
owns the model loop, provider adapters, tools, memory, skills, delegation,
approvals, and structured request logging.

The recommended entry is a Profile-oriented container: `new EkkoAgent()`
creates one `EkkoProfileAgent` per configured Profile, so modules are used as
`ekko.default.skill`, `ekko.default.memory`, or
`ekko.agent.get('work').tool`. See the complete field, method, parameter, and
configuration reference in [docs/API.md](docs/API.md).

`default` is always created, even when `profiles` is omitted or does not list
it. Existing first-level Profile directories under `.ekko/skills`,
`.ekko/logs`, and `.ekko/workspace` are discovered automatically; explicit
`profiles` are merged with those names and missing managed directories are
created before the Profile Agent is validated.

The first implemented layer is model-provider requests. Internally, the agent
uses one request shape and provider adapters translate it to external APIs.

Supported request styles:

- OpenAI Chat Completions style
- OpenAI-compatible providers such as DeepSeek, Qwen, Moonshot, Ollama
- OpenAI Responses
- Anthropic Messages
- Gemini Contents
- prompt completion
- custom runtime

First-class OAuth provider presets:

- `nous` — OpenAI Chat Completions at the Nous inference API
- `openai-codex` — OpenAI Responses at the ChatGPT Codex backend
- `xai-oauth` — OpenAI Responses at the xAI API
- `qwen-oauth` — OpenAI Chat Completions at the Qwen Portal API
- `claude-oauth` — Anthropic Messages at the Anthropic API
- `minimax-oauth` — Anthropic Messages for the MiniMax Coding Plan

Callers still own the interactive login flow, then store its result through
`setModelAuthorization`. Ekko persists and refreshes those credentials before
requests through a supplied provider refresher or a standard configured OAuth
token endpoint. Passing `apiKey` remains available as a one-process override.
MiniMax Coding Plan requests use Bearer-only authentication and do not send
`x-api-key`.

Default endpoints:

| Style | Default endpoint |
| --- | --- |
| `openai-chat` | `https://api.openai.com/v1/chat/completions` |
| `openai-responses` | `https://api.openai.com/v1/responses` |
| `anthropic-messages` | `https://api.anthropic.com/v1/messages` |
| `gemini-contents` | `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` |
| `prompt-completion` | `https://api.openai.com/v1/completions` |
| `custom-runtime` | `http://127.0.0.1:11434/v1/agent` |

Use `baseUrl` and `endpointPath` to override these defaults.

## Message Shape

All adapters receive the same internal message shape:

```ts
type AgentMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string
  toolCallId?: string
  toolCalls?: AgentToolCall[]
}
```

Use `normalizeAgentMessage()` or `normalizeAgentMessages()` at the boundary.
Model responses can be converted back to a single assistant message with
`modelResponseToAgentMessage()`. Streaming events can be collected into the same
shape with `collectModelEvents()`.

## Tools

Built-in tools:

- `clarify` asks one blocking user question, with optional answer choices, when
  the host provides an interactive clarification handler.
- `read_file` reads a text file.
- `write_file` writes text content and creates parent directories by default.
- `terminal_exec` runs a command with an argument array and `shell: false`.
- `code_exec` runs a one-shot Node.js or Python script. Scripts can call the
  allowed `read_file`, `write_file`, and `terminal_exec` tools through the
  generated `ekko_tools.mjs` or `ekko_tools.py` RPC bridge. Intermediate tool
  results remain inside the child script; only its reduced stdout is returned
  to the model.
- `skill_list` lists or searches skills under the agent's configured `skillDirectory`.
- `skill_view` loads `SKILL.md` or an allowed support file for one skill in that directory.
- `skill_manage` creates, patches, edits, archives, or manages support files when
  `skillDirectory` is configured.

Use `workspaceRoot` to keep file and terminal working directories inside a
specific workspace.

```ts
import { createDefaultToolRegistry } from 'ekko-agent'

const tools = createDefaultToolRegistry()

await tools.execute('write_file', {
  path: 'notes/todo.txt',
  content: 'ship tools',
}, {
  workspaceRoot: process.cwd(),
})

const result = await tools.execute('terminal_exec', {
  command: 'node',
  args: ['-v'],
}, {
  workspaceRoot: process.cwd(),
})

const batchResult = await tools.execute('code_exec', {
  language: 'node',
  code: `
    import { read_file } from './ekko_tools.mjs'
    const result = await read_file({ path: 'README.md' })
    console.log(result.content.split('\\n').slice(0, 5).join('\\n'))
  `,
}, {
  workspaceRoot: process.cwd(),
})
```

`code_exec` accepts `language: "node"` or `language: "python"`, runs for at
most the configured tool execution timeout, permits at most 50 nested tool
calls, caps stdout at 50KB, scrubs the child environment, and rejects recursive
or non-allowlisted tool calls.

Dangerous tools are authorized before execution. `code_exec` always requires
authorization because ordinary Node.js and Python source can access the host;
`terminal_exec` requires authorization for destructive, privileged,
remote-shell, package-publishing, service-control, and similar commands. The
available decisions are `once`, `session`, `always`, and `deny`. A session
decision stays in process memory for the matching chat session. An always
decision is stored in the global config under
`tools.approvals.permanentAllow`; denial fails closed before the tool starts.
The host supplies `requestToolApproval` in the per-run tool context to bridge
these decisions into its UI.

## Runtime

`AgentRuntime` ties messages, model requests, tools, skills, system prompt, and
events together. The default `maxSteps` is `90`, matching Hermes' regular agent
turn budget.

The default registry exposes `clarify` only for a foreground run whose
`AgentToolContext` provides `requestUserClarification`. Delegated subagents and
non-interactive hosts do not receive the tool. When available, the runtime
prompt requires blocking clarification questions to use the tool instead of
being returned as an ordinary assistant response.

When Ekko runs inside a host that owns conversation persistence, the host also
owns context compression. `estimateContext()` exposes the provider-visible
system, tool, message, and provider-context estimate needed for that external
threshold decision without starting a model call. A standalone Ekko host can
instead implement and own its internal compression lifecycle.

Call `new EkkoAgent()` (or the compatible `setupEkkoAgent()`) once during host
startup, before accepting agent work.
The setup entry owns `EkkoDirectoryManager`, creates
`<base>/.ekko/config/config.json`, the skills, logs, and workspace directories,
and opens and migrates the SQLite database. Development uses the package-local
`sql-data/ekko-agent.db`; production uses `<base>/.ekko/ekko.db`. It returns
the shared database-backed memory and conversation stores and closes that
process-level resource through `setup.close()`. The global JSON file drives
runtime limits, model defaults and providers, tools, approvals, delegation,
memory, skills, logging, and prompt instructions. Configuration upgrades merge
new defaults one field at a time: existing user values, arrays, and unknown
forward-compatible fields are never replaced as a whole module. A configured
profile uses
`<base>/.ekko/skills/<profile>` for its skills and
`<base>/.ekko/logs/<profile>` for its log. Its default per-session workspace is
`<base>/.ekko/workspace/<profile>/<session-id>`; an explicitly supplied
`workspaceRoot` or `cwd` takes precedence. The server supplies its Web UI home as
the base directory. For compatibility, the server supplies the Hermes root during
initialization. If `.ekko/skills` does not exist yet, the manager imports
the default profile from `<hermes>/skills` and every named profile from
`<hermes>/profiles/<profile>/skills`. This is a one-time copy: once
`.ekko/skills` exists, later startups do not resync or overwrite Ekko-owned
skills.

```ts
import { EkkoAgent } from 'ekko-agent'

const ekko = new EkkoAgent({
  baseDirectory: '/path/to/base',
  profiles: ['work'],
})
ekko.config.setModelProvider('deepseek', {
  type: 'openai-compatible',
  requestStyle: 'openai-chat',
  baseUrl: 'https://api.deepseek.com/v1',
  defaultModel: 'deepseek-chat',
  apiKey: 'sk-...',
})
ekko.config.setDefaultModel('deepseek')

const runtime = ekko.agent.get('work').runtime.create()

try {
  const result = await runtime.run({
    messages: ['Read README.md and summarize it.'],
    toolContext: {
      workspaceRoot: process.cwd(),
    },
    onEvent(event) {
      console.log(event.type)
    },
  })
} finally {
  ekko.close()
}
```

Set `toolsEnabled: false` to omit all tool sources (built-ins, MCP, memory,
and skill tools). Set `skillsEnabled: false` to omit constructor and per-run
skills. The switches are independent and default to `true`.

## Configuration and Models

`new EkkoAgent(options)` is the all-in-one public facade and multi-Profile
container. Every Profile gets an independent Agent instance with bound
`skill`, `tool`, `memory`, `conversation`, `runtime`, `directory`, and `log`
modules. Shared config, model Provider, authorization, and database modules are
also reachable through each Profile Agent. `setupEkkoAgent(options)` returns
the same facade for compatibility with the existing setup style.

`setup.config` is an `EkkoConfigStore`. It exposes `read`, `update`, `replace`,
`reset`, provider-preset CRUD, configured-provider CRUD, authorization CRUD,
`installModelProviderPreset`, and `setDefaultModel`. Nested
`update` patches merge at field level, so changing `runtime.maxSteps` does not
replace other runtime settings. `setup.modelProviderConfig()` resolves the
active provider, and `setup.createModelClient()` creates a client without
starting a runtime.

The config contains a curated `model.providerCatalog` derived from Hermes
Studio. It includes common API-key providers and the `nous`, `openai-codex`,
`xai-oauth`, `qwen-oauth`, `claude-oauth`, and `minimax-oauth` authorization
providers. Every preset has an explicit `apiMode`; Ekko validates that its
adapter-level `requestStyle` matches instead of relying on endpoint inference.

API-key credentials live in the provider object under `apiKey`. OAuth state
lives under `model.authorizations`. The
`.ekko/config/config.json` file is created with user-only `0600` permissions.
A caller can still pass `apiKey` to `setup.createModelClient()` or
`setup.createRuntime()` to override the persisted value for one process.

```ts
setup.config.update({
  runtime: { maxSteps: 60 },
  model: { reasoningEffort: 'high', maxTokens: 8_192 },
  tools: { codeExec: { enabled: false } },
})

const providers = setup.config.listModelProviders()
const client = setup.createModelClient({ provider: providers[0].id })
```

Install and manage a built-in provider with the exported config-store methods:

```ts
const agent = new EkkoAgent({ baseDirectory: '/path/to/base' })

agent.installModelProviderPreset('openai-codex', {
  defaultModel: 'gpt-5.6-terra',
})
agent.updateModelProvider('openai-codex', {
  defaultModel: 'gpt-5.6-sol',
})
agent.deleteModelProvider('openai-codex')
```

OAuth providers refresh before a request when their configured expiry is
within `model.authorizationRefreshLeewayMs`. Supply a provider-aware refresher
to `setupEkkoAgent`, or configure `tokenUrl`, `refreshToken`, and optional OAuth
client fields to use the exported standard refresh-token implementation.
Refreshes are deduplicated per provider, rotated credentials are persisted,
and refresh failures never fall back to an expiring stale token.

```ts
const setup = setupEkkoAgent({
  authorizationRefresher: async ({ provider, authorization }) => {
    const refreshed = await refreshProviderAuthorization(provider, authorization)
    return {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
      baseUrl: refreshed.baseUrl,
      apiMode: refreshed.apiMode,
    }
  },
})

setup.config.setModelAuthorization('openai-codex', {
  type: 'oauth',
  accessToken,
  refreshToken,
  expiresAt,
})

await setup.authorizations.refresh('openai-codex')
setup.config.updateModelAuthorization('openai-codex', { refreshToken: rotatedToken })
setup.config.deleteModelAuthorization('openai-codex')
```

## Sessions and Messages

The standalone database owns Studio-compatible `sessions` and `messages`
tables. `setup.conversations` exposes Session operations `createSession`,
`getSession`, `listSessions`, `updateSession`, `renameSession`,
`setSessionArchived`, `endSession`, `reopenSession`, `deleteSession`, and
`getSessionDetail`. Message operations are `addMessage`, `addMessages`,
`getMessage`, `listMessages`, `updateMessage`, `deleteMessage`, and
`clearMessages`. `recordSessionUsage` accumulates model usage independently of
message edits.

```ts
const session = setup.conversations.createSession({
  profile: 'default',
  provider: 'deepseek',
  model: 'deepseek-chat',
  title: 'Repository review',
})

setup.conversations.addMessage({
  sessionId: session.id,
  role: 'user',
  content: 'Review this repository.',
})

setup.conversations.renameSession(session.id, 'Ekko repository review')
const history = setup.conversations.listMessages(session.id)
```

## Memory

`setup.memory` exposes the standalone memory API. Memory-node operations are
`list`, `get`, `search`, `create`, `update`, `expire`, `delete`, and `forget`.
Conversation-derived memory data can be read with `listMessages`,
`getLatestSummary`, `getSessionState`, and `listAuditEvents`. The lower-level
SQLite implementation remains available as `setup.memoryStore`.

```ts
const created = await setup.memory.create({
  kind: 'general_preference',
  itemKey: 'interface_theme',
  reason: 'User selected a persistent preference.',
  explicitUserIntent: true,
  identity: { sessionId: session.id, profileId: 'default' },
  node: {
    valueJson: 'dark',
    title: 'Interface theme',
    content: 'The user prefers a dark interface.',
  },
})

const memories = await setup.memory.list({ profileId: 'default', limit: 20 })
const updated = await setup.memory.update(created.nodeId!, {
  reason: 'User changed the preference.',
  expectedRevision: created.node!.revision,
  identity: { sessionId: session.id, profileId: 'default' },
  node: { valueJson: 'light' },
})

// Soft delete is the default. Hard delete additionally requires confirmed: true.
await setup.memory.delete(updated.nodeId!, {
  reason: 'User asked Ekko to forget it.',
  expectedRevision: updated.node!.revision,
  identity: { sessionId: session.id, profileId: 'default' },
})
```

## Skill Evolution

Ekko exposes `skill_manage` to the foreground agent when `skillDirectory` is
configured. Existing files must first be loaded through `skill_view` in the
same run. The mutation is rejected if the file changed after it was viewed.
Overwrites create a recoverable copy under
`.ekko/skills/<profile>/.ekko-backups`, while confirmed skill deletion moves
the directory under `.ekko/skills/<profile>/.ekko-archive`.

After 10 cumulative tool calls in one session, the runtime schedules a
background procedural review. The review uses a dedicated conservative prompt
and only `skill_list`, `skill_view`, and `skill_manage`; it does not block the
foreground response. It can create a reusable class-level skill, but can update
only skills marked as created by Ekko and cannot delete. Set
`skillReviewEveryToolCalls: 0` to disable this review or provide another positive
threshold.

## File Logging

Each profile writes structured JSON Lines to one file:
`.ekko/logs/<profile>/ekko-agent.jsonl`. The file is capped at 10 MiB. When the
next event would exceed that cap, the existing content is discarded and
logging continues in the same file; no rotated or per-session files are
created.

The persistent log is intentionally request-only. Every model-client request
attempt writes one terminal `model.request` record after it completes or fails.
That single record combines safe request metadata, status, duration, usage, and
response sizes. Runtime events, streaming deltas, tool events, prompts, and
response bodies are not written, so log volume tracks model calls instead of
the much larger runtime event stream.

Endpoints and common credential shapes are redacted, large strings are
truncated, and base64 payloads are omitted. `EkkoFileLogReader.query()` can
filter the current file by session, run, turn, category, level, event, time, or
text without acquiring write ownership. The Hermes Web UI Logs page exposes the
same file as the `ekko-agent` source for the selected profile.

## Commands

```bash
npm install
npm run check
npm test
npm run build
```

## Example

```ts
import { createModelClient } from 'ekko-agent'

const client = createModelClient({
  id: 'deepseek',
  type: 'openai-compatible',
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseUrl: 'https://api.deepseek.com/v1',
  defaultModel: 'deepseek-chat',
})

const response = await client.create({
  messages: [{ role: 'user', content: 'Say hello.' }],
})
```
