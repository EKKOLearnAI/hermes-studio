import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

function runPython(script: string): Record<string, unknown> {
  try {
    return JSON.parse(execFileSync('python3', ['-c', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: 'pipe',
    }))
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string }
    throw new Error([
      err.message || 'Python provider credentials bridge test failed',
      err.stdout ? `stdout:\n${err.stdout}` : '',
      err.stderr ? `stderr:\n${err.stderr}` : '',
    ].filter(Boolean).join('\n\n'))
  }
}

describe('Agent Bridge provider credentials', () => {
  it('resolves xAI credentials through the worker action without starting an Agent run', () => {
    const result = runPython(String.raw`
import json
import sys
from pathlib import Path

bridge_dir = Path("packages/server/src/modules/hermes/services/bridge/python").resolve()
sys.path.insert(0, str(bridge_dir))
import bridge_server

calls = []
def resolve_runtime(model, provider):
    calls.append({"model": model, "provider": provider})
    return {
        "provider": provider,
        "api_mode": "codex_responses",
        "base_url": "https://api.x.ai/v1",
        "api_key": "fresh-token",
        "source": "test",
    }

bridge_server._resolve_runtime = resolve_runtime
server = object.__new__(bridge_server.BridgeServer)
response = server.handle({
    "action": "provider_credentials",
    "provider": "xai-oauth",
    "model": "grok-4.3",
})
print(json.dumps({"response": response, "calls": calls}))
`)

    expect(result).toEqual({
      response: {
        resolved: true,
        requested_provider: 'xai-oauth',
        provider: 'xai-oauth',
        api_key: 'fresh-token',
        base_url: 'https://api.x.ai/v1',
        api_mode: 'codex_responses',
        source: 'test',
        last_refresh: null,
        expires_at: null,
        expires_at_ms: null,
      },
      calls: [{ model: 'grok-4.3', provider: 'xai-oauth' }],
    })
  })

  it('uses Hermes MiniMax refresh resolution instead of a stale generic pool entry', () => {
    const result = runPython(String.raw`
import json
import sys
import types
from pathlib import Path

bridge_dir = Path("packages/server/src/modules/hermes/services/bridge/python").resolve()
sys.path.insert(0, str(bridge_dir))
import bridge_server

calls = []
auth_module = types.ModuleType("hermes_cli.auth")
def resolve_minimax_oauth_runtime_credentials():
    calls.append("minimax-refresh")
    return {
        "api_key": "fresh-minimax-token",
        "base_url": "https://api.minimaxi.com/anthropic",
        "source": "oauth",
    }
auth_module.resolve_minimax_oauth_runtime_credentials = resolve_minimax_oauth_runtime_credentials
hermes_cli_module = types.ModuleType("hermes_cli")
hermes_cli_module.auth = auth_module
sys.modules["hermes_cli"] = hermes_cli_module
sys.modules["hermes_cli.auth"] = auth_module

bridge_server._ensure_agent_imports = lambda: None
bridge_server._resolve_runtime = lambda *_args: (_ for _ in ()).throw(
    AssertionError("generic resolver must not handle MiniMax credentials")
)
server = object.__new__(bridge_server.BridgeServer)
response = server.handle({
    "action": "provider_credentials",
    "provider": "minimax-oauth",
    "model": "MiniMax-M3",
})
print(json.dumps({"response": response, "calls": calls}))
`)

    expect(result).toEqual({
      response: {
        resolved: true,
        requested_provider: 'minimax-oauth',
        provider: 'minimax-oauth',
        api_key: 'fresh-minimax-token',
        base_url: 'https://api.minimaxi.com/anthropic',
        api_mode: 'anthropic_messages',
        source: 'oauth',
        last_refresh: null,
        expires_at: null,
        expires_at_ms: null,
      },
      calls: ['minimax-refresh'],
    })
  })

  it('forwards the profile, provider, and model from the TypeScript client', async () => {
    const { AgentBridgeClient } = await import(
      '../../packages/server/src/modules/hermes/services/bridge/client'
    )
    const client = new AgentBridgeClient({
      endpoint: 'tcp://127.0.0.1:1',
      connectRetryMs: 0,
      timeoutMs: 1,
    })
    const request = vi.spyOn(client, 'request').mockResolvedValue({
      ok: true,
      resolved: true,
      requested_provider: 'minimax-oauth',
    })

    await client.providerCredentials('research', 'minimax-oauth', 'MiniMax-M3')

    expect(request).toHaveBeenCalledWith({
      action: 'provider_credentials',
      profile: 'research',
      provider: 'minimax-oauth',
      model: 'MiniMax-M3',
    })
  })
})
