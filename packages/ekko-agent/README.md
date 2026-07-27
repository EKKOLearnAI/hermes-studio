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
```

## Runtime

`AgentRuntime` ties messages, model requests, tools, skills, system prompt, and
events together. The default `maxSteps` is `90`, matching Hermes' regular agent
turn budget.

When Ekko runs inside a host that owns conversation persistence, the host also
owns context compression. `estimateContext()` exposes the provider-visible
system, tool, message, and provider-context estimate needed for that external
threshold decision without starting a model call. A standalone Ekko host can
instead implement and own its internal compression lifecycle.

Ekko owns one filesystem root through `EkkoDirectoryManager`. The manager takes
one optional base directory (the user's home directory by default), creates
`<base>/.ekko/skills`, and keeps the SQLite database at
`<base>/.ekko/ekko.db`. A running profile uses
`<base>/.ekko/skills/<profile>` for its skills and
`<base>/.ekko/logs/<profile>` for its log. The server supplies its Web UI home
as the base directory. For compatibility, the server supplies the Hermes root
during initialization. If `.ekko/skills` does not exist yet, the manager imports
the default profile from `<hermes>/skills` and every named profile from
`<hermes>/profiles/<profile>/skills`. This is a one-time copy: once
`.ekko/skills` exists, later startups do not resync or overwrite Ekko-owned
skills.

```ts
import { AgentRuntime, EkkoDirectoryManager } from './src/index'

const directories = new EkkoDirectoryManager('/path/to/base')
directories.initialize()
const runtime = new AgentRuntime({
  modelClient: client,
  skillDirectory: directories.profileSkillsDirectory('default'),
})

const result = await runtime.run({
  messages: ['Read README.md and summarize it.'],
  toolContext: {
    workspaceRoot: process.cwd(),
  },
  onEvent(event) {
    console.log(event.type)
  },
})
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

Entries use the `run`, `model`, `tool`, `context`, `skill`, `memory`, and
`system` categories. Large strings are truncated, base64 payloads are omitted,
and common credential fields and bearer tokens are redacted. Streaming text
and reasoning deltas are not logged.

`EkkoFileLogger.query()` and `GlobalEkkoAgent.queryLogs()` can filter the
current file by session, run, turn, category, level, event, time, or text. The
Hermes Web UI Logs page exposes the same file as the `ekko-agent` source for the
selected profile.

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
