import { execFileSync } from 'child_process'
import { describe, expect, it } from 'vitest'

function runPython(script: string): any {
  try {
    return JSON.parse(execFileSync('python3', ['-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: 'pipe',
    }))
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string }
    throw new Error([
      err.message || 'Python bridge usage hook script failed',
      err.stdout ? `stdout:\n${err.stdout}` : '',
      err.stderr ? `stderr:\n${err.stderr}` : '',
    ].filter(Boolean).join('\n\n'))
  }
}

const harness = String.raw`
import contextlib
import importlib.util
import json
import sys
import tempfile
import types
from pathlib import Path

bridge_runtime = types.ModuleType("bridge_runtime")
bridge_runtime.APPROVAL_TIMEOUT_MS = 1000
bridge_runtime.APPROVAL_TIMEOUT_SECONDS = 1
bridge_runtime._approval_pattern_keys = lambda *_args, **_kwargs: []
bridge_runtime._base_hermes_home = lambda: Path(tempfile.gettempdir())
bridge_runtime._bridge_platform = lambda: "agent-bridge"
bridge_runtime._cfg_max_turns = lambda *_args, **_kwargs: 20
bridge_runtime._discover_bridge_mcp_tools = lambda *_args, **_kwargs: []
bridge_runtime._ensure_agent_imports = lambda: None
bridge_runtime._hermes_home = lambda *_args, **_kwargs: Path(tempfile.gettempdir())
bridge_runtime._install_execute_code_approval_memory_patch = lambda *_args, **_kwargs: None
bridge_runtime._jsonable = lambda value: value
bridge_runtime._load_cfg = lambda *_args, **_kwargs: {}
bridge_runtime._load_enabled_toolsets = lambda *_args, **_kwargs: []
bridge_runtime._load_reasoning_config = lambda *_args, **_kwargs: {}
bridge_runtime._load_service_tier = lambda *_args, **_kwargs: None
bridge_runtime._mcp_tool_names_from_names = lambda *_args, **_kwargs: []
bridge_runtime._persist_execute_code_approval_choice = lambda *_args, **_kwargs: None
bridge_runtime._profile_home = lambda *_args, **_kwargs: Path(tempfile.gettempdir())
bridge_runtime._refresh_approval_allowlist = lambda *_args, **_kwargs: None
bridge_runtime._refresh_worker_profile_env = lambda *_args, **_kwargs: None
bridge_runtime._resolve_model = lambda *_args, **_kwargs: "model"
bridge_runtime._resolve_runtime = lambda *_args, **_kwargs: {}
bridge_runtime._suppress_bridge_platform_hint = lambda: None
bridge_runtime._title_user_message = lambda value: value
bridge_runtime._tool_names_from_definitions = lambda *_args, **_kwargs: []

@contextlib.contextmanager
def _profile_env(_profile):
    yield

bridge_runtime._profile_env = _profile_env
sys.modules["bridge_runtime"] = bridge_runtime

plugins = types.ModuleType("hermes_cli.plugins")
class PluginManager:
    def __init__(self):
        self._hooks = {}
manager = PluginManager()
plugins.get_plugin_manager = lambda: manager
hermes_cli = types.ModuleType("hermes_cli")
hermes_cli.__path__ = []
sys.modules["hermes_cli"] = hermes_cli
sys.modules["hermes_cli.plugins"] = plugins

spec = importlib.util.spec_from_file_location(
    "bridge_pool",
    "packages/server/src/services/hermes/agent-bridge/python/bridge_pool.py",
)
bridge_pool = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules["bridge_pool"] = bridge_pool
spec.loader.exec_module(bridge_pool)
`

describe('agent bridge model usage hook', () => {
  it('registers once and appends exact provider usage to the active run', () => {
    const result = runPython(`${harness}
pool = bridge_pool.AgentPool()
pool._install_usage_hook()
pool._install_usage_hook()
agent = types.SimpleNamespace()
session = bridge_pool.AgentSession("session-1", agent, current_run_id="run-1")
run = bridge_pool.RunRecord("run-1", "session-1")
pool._sessions["session-1"] = session
pool._runs["run-1"] = run

callback = manager._hooks["post_api_request"][0]
callback(
    session_id="session-1",
    api_request_id="request-1",
    turn_id="turn-1",
    api_call_count=2,
    model="requested-model",
    response_model="response-model",
    provider="openai",
    api_mode="responses",
    usage={
        "input_tokens": 101,
        "output_tokens": 22,
        "cache_read_tokens": 70,
        "cache_write_tokens": 5,
        "reasoning_tokens": 9,
    },
)
print(json.dumps({"callback_count": len(manager._hooks["post_api_request"]), "events": run.events}))
`)

    expect(result.callback_count).toBe(1)
    expect(result.events).toEqual([expect.objectContaining({
      event: 'model.usage',
      api_request_id: 'request-1',
      turn_id: 'turn-1',
      api_call_count: 2,
      model: 'response-model',
      provider: 'openai',
      api_mode: 'responses',
      usage: {
        input_tokens: 101,
        output_tokens: 22,
        cache_read_tokens: 70,
        cache_write_tokens: 5,
        reasoning_tokens: 9,
      },
    })])
  })
})
