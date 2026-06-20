import { execFileSync } from 'child_process'
import { describe, expect, it } from 'vitest'

function runPython(script: string): any {
  try {
    const output = execFileSync('python3', ['-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: 'pipe',
    })
    return JSON.parse(output)
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string }
    throw new Error([
      err.message || 'Python bridge MCP filter script failed',
      err.stdout ? `stdout:\n${err.stdout}` : '',
      err.stderr ? `stderr:\n${err.stderr}` : '',
    ].filter(Boolean).join('\n\n'))
  }
}

describe('agent bridge MCP tools filtering', () => {
  it('treats an empty include list as an active filter and keeps raw listing unfiltered', () => {
    const result = runPython(String.raw`
import importlib.util
import json
import sys
import threading
from pathlib import Path

path = Path("packages/server/src/services/hermes/agent-bridge/python/hermes_bridge.py")
spec = importlib.util.spec_from_file_location("hermes_bridge", path)
bridge = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = bridge
spec.loader.exec_module(bridge)

class Tool:
    def __init__(self, name):
        self.name = name
        self.description = f"{name} description"
        self.inputSchema = {"type": "object"}

class Task:
    _task = None
    _error = None

    def __init__(self):
        self._tools = [Tool("read_file"), Tool("write_file"), Tool("delete_file")]
        self._registered_tool_names = ["read_file", "write_file", "delete_file"]
        self._config = {"command": "mcp-server"}

server = bridge.BridgeServer("tcp://127.0.0.1:0")
servers = {"fs": Task()}
lock = threading.RLock()

def names(response):
    return [tool["name"] for tool in response["results"][0]["tools"]]

server._read_mcp_config = lambda profile: {
    "mcp_servers": {
        "fs": {
            "command": "mcp-server",
            "tools": {"include": []},
        },
    },
}
include_empty = server._mcp_tools_list({"server": "fs"}, "default", servers, lock)
include_empty_list = server._mcp_list("default", servers, lock)
include_empty_raw = server._mcp_tools_list({"server": "fs", "raw": True}, "default", servers, lock)

server._read_mcp_config = lambda profile: {
    "mcp_servers": {
        "fs": {
            "command": "mcp-server",
            "tools": {"include": ["read_file"]},
        },
    },
}
include_one = server._mcp_tools_list({"server": "fs"}, "default", servers, lock)

server._read_mcp_config = lambda profile: {
    "mcp_servers": {
        "fs": {
            "command": "mcp-server",
            "tools": {"exclude": ["delete_file"]},
        },
    },
}
exclude_one = server._mcp_tools_list({"server": "fs"}, "default", servers, lock)

print(json.dumps({
    "include_empty": names(include_empty),
    "include_empty_details": include_empty_list["servers"][0]["tool_details"],
    "include_empty_raw": names(include_empty_raw),
    "include_one": names(include_one),
    "exclude_one": names(exclude_one),
}))
`)

    expect(result).toEqual({
      include_empty: [],
      include_empty_details: [],
      include_empty_raw: ['read_file', 'write_file', 'delete_file'],
      include_one: ['read_file'],
      exclude_one: ['read_file', 'write_file'],
    })
  })
})
