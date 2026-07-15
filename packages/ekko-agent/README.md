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

In development, Ekko Agent stores its SQLite database at
`packages/ekko-agent/sql-data/ekko-agent.db`. It uses the same single-file
SQLite/DELETE journal layout as `packages/server/data/hermes-web-ui.db`, so the
database can be opened directly in Navicat. Tests remain isolated in temporary
directories. While the production Ekko Agent entry remains hidden, the server
starts Ekko Agent with memory disabled and does not create the `ekko` directory
or `HERMES_WEB_UI_HOME/ekko/ekko.db`.

```ts
import { AgentRuntime, createDefaultToolRegistry } from './src/index'

const runtime = new AgentRuntime({
  modelClient: client,
  tools: createDefaultToolRegistry(),
  skills: [{
    id: 'project',
    name: 'Project Skill',
    instructions: 'Follow the project conventions before editing files.',
  }],
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
