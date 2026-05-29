# CC Switch Claude Code / Codex Config Notes

Source project inspected: `/Users/ekko/Downloads/cc-switch-main`

## Overall Model

CC Switch keeps provider, MCP, prompt, and skill state in its own storage, then projects the selected provider into each CLI's live config files.

- CC Switch app data: `~/.cc-switch/`
- Main database: `~/.cc-switch/cc-switch.db`
- Device settings: `~/.cc-switch/settings.json`
- Provider records store a `settings_config` JSON payload.
- Switching providers writes only the target app's live config files.

## Claude Code

Default config directory:

```text
~/.claude/
```

Main live config:

```text
~/.claude/settings.json
```

Compatibility:

- If `~/.claude/settings.json` exists, CC Switch uses it.
- If legacy `~/.claude/claude.json` exists, CC Switch can continue using it.
- If a custom Claude config directory is set, that directory replaces `~/.claude`.

Typical provider shape:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.example.com",
    "ANTHROPIC_API_KEY": "sk-xxx",
    "ANTHROPIC_AUTH_TOKEN": "token",
    "ANTHROPIC_MODEL": "model-name",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "model-name",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "model-name",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "model-name"
  }
}
```

Write behavior:

- On provider switch, `settings_config` is written to Claude Code live config.
- Internal-only keys such as `api_format`, `apiFormat`, `openrouter_compat_mode`, and `openrouterCompatMode` are removed before writing.
- Official Claude provider uses an empty `env` object so Claude CLI can use its default authentication flow.

Claude MCP:

```text
~/.claude.json
```

MCP shape:

```json
{
  "mcpServers": {
    "mcp-fetch": {
      "command": "uvx",
      "args": ["mcp-server-fetch"]
    }
  }
}
```

MCP sync behavior:

- Claude MCP is written to `mcpServers` in `~/.claude.json`.
- Sync only runs if `~/.claude/` or `~/.claude.json` already exists.
- If a custom Claude config directory is set, the MCP JSON path is derived from that directory name at the same parent level.
  Example: `/tmp/profile/.claude` -> `/tmp/profile/.claude.json`.
- On Windows, stdio commands like `npx`, `npm`, `yarn`, `pnpm`, `node`, `bun`, and `deno` are wrapped as `cmd /c ...` unless the target is a WSL path.

Claude prompts and skills:

```text
~/.claude/CLAUDE.md
~/.claude/skills/
```

## Codex

Default config directory:

```text
~/.codex/
```

Main live files:

```text
~/.codex/auth.json
~/.codex/config.toml
~/.codex/AGENTS.md
~/.codex/skills/
```

Generated model catalog file:

```text
~/.codex/cc-switch-model-catalog.json
```

Typical provider shape:

```json
{
  "auth": {
    "OPENAI_API_KEY": "sk-xxx"
  },
  "config": "model_provider = \"custom\"\nmodel = \"gpt-5.4\"\n..."
}
```

Typical third-party `config.toml`:

```toml
model_provider = "custom"
model = "gpt-5.4"
model_reasoning_effort = "high"
disable_response_storage = true

[model_providers.custom]
name = "custom"
base_url = "https://api.example.com/v1"
wire_api = "responses"
requires_openai_auth = true
```

Write behavior:

- Official provider with real login material writes both `auth.json` and `config.toml`.
- Third-party provider switches normally write only `config.toml`.
- For third-party providers, CC Switch keeps the provider API key in stored `auth.OPENAI_API_KEY`, but writes it into live `config.toml` as `experimental_bearer_token`.
- This avoids overwriting the user's long-lived ChatGPT / Codex OAuth login cache in `auth.json`.

Stable model provider behavior:

- CC Switch normalizes custom Codex `model_provider` ids to stable `custom`.
- Reason: Codex history/resume is keyed by `model_provider`; stable ids prevent history from appearing to move when switching third-party providers.
- Reserved Codex provider ids include `openai`, `ollama`, `lmstudio`, `oss`, `ollama-chat`, and `amazon-bedrock`.

Codex model catalog:

- If provider settings include a simplified model catalog, CC Switch generates `cc-switch-model-catalog.json`.
- It also injects `model_catalog_json` into `config.toml`.
- The catalog is generated from Codex's bundled/cache model template when available.

Codex MCP:

MCP is stored inside:

```text
~/.codex/config.toml
```

Correct format:

```toml
[mcp_servers.mcp-fetch]
command = "uvx"
args = ["mcp-server-fetch"]
```

MCP sync behavior:

- CC Switch uses top-level `[mcp_servers]`.
- It preserves unrelated `config.toml` fields.
- It cleans up the legacy/wrong `[mcp.servers]` form when syncing.
- Sync only runs if `~/.codex/` already exists.

Codex prompts and skills:

```text
~/.codex/AGENTS.md
~/.codex/skills/
```

## Important Source Files In CC Switch

Claude:

- `/Users/ekko/Downloads/cc-switch-main/src-tauri/src/config.rs`
- `/Users/ekko/Downloads/cc-switch-main/src-tauri/src/claude_mcp.rs`
- `/Users/ekko/Downloads/cc-switch-main/src-tauri/src/mcp/claude.rs`
- `/Users/ekko/Downloads/cc-switch-main/src/config/claudeProviderPresets.ts`

Codex:

- `/Users/ekko/Downloads/cc-switch-main/src-tauri/src/codex_config.rs`
- `/Users/ekko/Downloads/cc-switch-main/src-tauri/src/mcp/codex.rs`
- `/Users/ekko/Downloads/cc-switch-main/src/config/codexProviderPresets.ts`
- `/Users/ekko/Downloads/cc-switch-main/src/config/codexTemplates.ts`

Shared provider live write path:

- `/Users/ekko/Downloads/cc-switch-main/src-tauri/src/services/provider/live.rs`
- `/Users/ekko/Downloads/cc-switch-main/src-tauri/src/services/proxy.rs`

