import { execFileSync } from 'child_process'
import { describe, expect, it, vi } from 'vitest'
import { resolveBridgeTestPython } from './python-test-runtime'

const testPython = resolveBridgeTestPython()

function runPython(script: string): any {
  try {
    return JSON.parse(execFileSync(testPython, ['-c', script], {
      cwd: process.cwd(), encoding: 'utf-8', stdio: 'pipe',
    }))
  } catch (error) {
    const cause = error as { stdout?: string; stderr?: string; message?: string }
    throw new Error([cause.message, cause.stdout, cause.stderr].filter(Boolean).join('\n\n'))
  }
}

describe('agent bridge internal MCP tool calls', () => {
  it('calls only the exact configured, filter-allowed, registered tool and sanitizes its result', () => {
    const result = runPython(String.raw`
import importlib.util
import json
import os
import re
import sys
import threading
import types
from pathlib import Path

os.environ["HERMES_AGENT_BRIDGE_WORKER_PROFILE"] = "default"
path = Path("packages/server/src/services/hermes/agent-bridge/python/hermes_bridge.py")
spec = importlib.util.spec_from_file_location("hermes_bridge", path)
bridge = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = bridge
spec.loader.exec_module(bridge)

calls = []
responses = {"value": json.dumps({
    "result": json.dumps({"items": [{"bvid": "BV1xx411c7mD", "title": "Hermes", "author": "Alice"}]})
})}

class Tool:
    def __init__(self, name):
        self.name = name
        self.description = name
        self.inputSchema = {"type": "object"}

class Task:
    session = object()
    _tools = [Tool("search_videos"), Tool("like_video")]
    _registered_tool_names = ["mcp_bilibili_search_videos", "mcp_bilibili_like_video"]

def make_handler(server, tool, timeout):
    def call(arguments):
        calls.append({"server": server, "tool": tool, "timeout": timeout, "arguments": arguments})
        return responses["value"]
    return call

mcp_tool = types.ModuleType("tools.mcp_tool")
mcp_tool.discover_mcp_tools = lambda: []
mcp_tool.register_mcp_servers = lambda config: None
mcp_tool.sanitize_mcp_name_component = lambda value: re.sub(r"[^A-Za-z0-9_]", "_", value)
mcp_tool._make_tool_handler = make_handler
mcp_tool._run_on_mcp_loop = lambda factory, timeout=30: factory()
mcp_tool._servers = {"bilibili": Task()}
mcp_tool._lock = threading.RLock()
tools_pkg = types.ModuleType("tools")
tools_pkg.__path__ = []
sys.modules["tools"] = tools_pkg
sys.modules["tools.mcp_tool"] = mcp_tool

server = bridge.BridgeServer("tcp://127.0.0.1:0")
config = {"mcp_servers": {"bilibili": {"tools": {"include": ["search_videos"]}}}}
server._read_mcp_config = lambda profile: config

def invoke(**changes):
    request = {"action": "mcp_tool_call", "profile": "default", "server": "bilibili",
               "tool": "search_videos", "arguments": {"query": "Hermes", "limit": 5}, "timeout": 12}
    request.update(changes)
    return server._handle_mcp_action("mcp_tool_call", request, request.get("profile"))

success = invoke()
filtered = invoke(tool="like_video")
secret_arguments = invoke(arguments={"access_token": "must-not-persist"})
wrong_profile = invoke(profile="other")
unconfigured = invoke(server="other")

responses["value"] = json.dumps({"result": {"access_token": "must-not-persist"}})
secret_result = invoke()
responses["value"] = json.dumps({"error": "Bearer must-not-persist"})
tool_error = invoke()

Task._registered_tool_names = []
not_registered = invoke()

delattr(mcp_tool, "_make_tool_handler")
delattr(mcp_tool, "sanitize_mcp_name_component")
management_without_private = server._handle_mcp_action(
    "mcp_tools_list", {"action": "mcp_tools_list", "server": "bilibili"}, "default"
)
execution_without_private = invoke()

print(json.dumps({
    "success": success,
    "filtered": filtered,
    "secret_arguments": secret_arguments,
    "wrong_profile": wrong_profile,
    "unconfigured": unconfigured,
    "secret_result": secret_result,
    "tool_error": tool_error,
    "not_registered": not_registered,
    "management_without_private": management_without_private,
    "execution_without_private": execution_without_private,
    "calls": calls,
}))
`)

    expect(result.success).toEqual({
      ok: true, server: 'bilibili', tool: 'search_videos', status: 'succeeded', error_code: null,
      result: { items: [{ bvid: 'BV1xx411c7mD', title: 'Hermes', author: 'Alice' }] },
    })
    expect(result.calls[0]).toEqual({
      server: 'bilibili', tool: 'search_videos', timeout: 12, arguments: { query: 'Hermes', limit: 5 },
    })
    expect(result.filtered).toMatchObject({ ok: false, error_code: 'MCP_TOOL_FILTERED' })
    expect(result.secret_arguments).toMatchObject({ ok: false, error_code: 'MCP_ARGUMENTS_INVALID' })
    expect(result.wrong_profile).toMatchObject({ ok: false, error_code: 'MCP_PROFILE_MISMATCH' })
    expect(result.unconfigured).toMatchObject({ ok: false, error_code: 'MCP_SERVER_NOT_CONFIGURED' })
    expect(result.secret_result).toMatchObject({ ok: true, status: 'error', error_code: 'MCP_TOOL_FAILED', result: null })
    expect(result.tool_error).toMatchObject({ ok: true, status: 'error', error_code: 'MCP_TOOL_FAILED', result: null })
    expect(result.not_registered).toMatchObject({ ok: false, error_code: 'MCP_TOOL_NOT_REGISTERED' })
    expect(result.management_without_private).toMatchObject({ ok: true, results: [{ server: 'bilibili' }] })
    expect(result.execution_without_private).toMatchObject({ ok: false, error_code: 'MCP_EXECUTION_UNAVAILABLE' })
    expect(JSON.stringify(result)).not.toContain('must-not-persist')
    expect(result.calls).toHaveLength(3)
  })

  it('forwards an internal typed client request with a bounded timeout', async () => {
    const { AgentBridgeClient } = await import('../../packages/server/src/services/hermes/agent-bridge/client')
    const client = new AgentBridgeClient({ endpoint: 'tcp://127.0.0.1:1', connectRetryMs: 0, timeoutMs: 1 })
    const request = vi.spyOn(client, 'request').mockResolvedValue({
      ok: true, server: 'bilibili', tool: 'search_videos', status: 'succeeded', error_code: null, result: {},
    })
    await client.mcpToolCall('bilibili', 'search_videos', { query: 'Hermes' }, 'default', 120_000)
    expect(request).toHaveBeenCalledWith({
      action: 'mcp_tool_call', server: 'bilibili', tool: 'search_videos', arguments: { query: 'Hermes' },
      profile: 'default', timeout: 60,
    }, { timeoutMs: 75_000 })
  })
})
