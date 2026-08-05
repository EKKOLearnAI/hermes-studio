# Ekko Agent

Ekko Agent is a package scaffold for future Hermes Web UI agent integration.

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

Pass the current OAuth access token as `apiKey`. Login, token persistence, and
refresh remain the caller's responsibility; the preset supplies the provider's
default endpoint, request style, and required identity headers.

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
import { createDefaultToolRegistry } from './src/index'

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

When Ekko runs inside a host that owns conversation persistence, the host also
owns context compression. `estimateContext()` exposes the provider-visible
system, tool, message, and provider-context estimate needed for that external
threshold decision without starting a model call. A standalone Ekko host can
instead implement and own its internal compression lifecycle.

Call `setupEkkoAgent()` once during host startup, before accepting agent work.
The setup entry owns `EkkoDirectoryManager`, creates
`<base>/.ekko/config/config.json`, the skills, logs, and workspace directories,
and opens and migrates the SQLite database at `<base>/.ekko/ekko.db`. It returns
the shared database-backed memory service and closes that process-level resource
through `setup.close()`. The global JSON file is initialized from Ekko's current
runtime defaults. General runtime settings are not yet loaded as user- or
profile-configurable input; the permanent tool-approval allowlist is the current
exception. A configured profile uses
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
import { AgentRuntime, setupEkkoAgent } from './src/index'

const setup = setupEkkoAgent({
  baseDirectory: '/path/to/base',
  profiles: ['default'],
})
const profile = setup.profile('default')
const runtime = new AgentRuntime({
  modelClient: client,
  memory: setup.memory,
  skillDirectory: profile.skillDirectory,
  toolAuthorizer: setup.toolApprovals.authorize,
})

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
  setup.close()
}
```

Set `toolsEnabled: false` to omit all tool sources (built-ins, MCP, memory,
and skill tools). Set `skillsEnabled: false` to omit constructor and per-run
skills. The switches are independent and default to `true`.

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
npm --prefix packages/ekko-agent run check
```

## Example

```ts
import { createModelClient } from './src/index'

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
