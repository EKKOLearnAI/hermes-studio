import { execFileSync } from 'child_process'
import { describe, expect, it } from 'vitest'

describe('agent bridge MCP runtime imports', () => {
  it.each(['split', 'legacy'])('supports %s runtime management, cleanup and discovery', (layout) => {
    const output = execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', String.raw`
import importlib.util
import json
import sys
import threading
import types
from pathlib import Path

path = Path("packages/server/src/modules/hermes/services/bridge/python/hermes_bridge.py")
spec = importlib.util.spec_from_file_location("hermes_bridge", path)
bridge = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = bridge
spec.loader.exec_module(bridge)

# No installed Hermes runtime or live MCP servers are needed.
for name in list(sys.modules):
    if name == "tools" or name.startswith("tools."):
        del sys.modules[name]
tools = types.ModuleType("tools")
tools.__path__ = []
sys.modules["tools"] = tools
core = types.ModuleType("tools.mcp_tool")
core._servers = {}
core._lock = threading.RLock()
sys.modules[core.__name__] = core
calls = []
def discover():
    calls.append("discover")
    return ["mcp_probe_read"]
def register():
    calls.append("register")
def run_on_loop(fn, timeout):
    calls.append("loop")
    return fn()

if sys.argv[1] == "split":
    loop = types.ModuleType("tools.mcp_tool_loop")
    loop._run_on_mcp_loop = run_on_loop
    sys.modules[loop.__name__] = loop
    discovery = types.ModuleType("tools.mcp_tool_discovery")
    discovery.discover_mcp_tools = discover
    discovery.register_mcp_servers = register
    sys.modules[discovery.__name__] = discovery
    # Access to deprecated aliases must never be attempted on split runtimes.
    def reject_alias(name):
        if name in ("discover_mcp_tools", "register_mcp_servers", "_run_on_mcp_loop"):
            raise AssertionError("deprecated core alias: " + name)
        raise AttributeError(name)
    core.__getattr__ = reject_alias
else:
    sys.modules["tools.mcp_tool_loop"] = None
    sys.modules["tools.mcp_tool_discovery"] = None
    core._run_on_mcp_loop = run_on_loop
    core.discover_mcp_tools = discover
    core.register_mcp_servers = register

server = bridge.BridgeServer("tcp://127.0.0.1:0")
server._read_mcp_config = lambda profile: {"mcp_servers": {}}
listed = server._handle_mcp_action("mcp_list", {}, "default")
# Verify that reload dispatch receives the resolved functions and shared state.
def reload(req, profile, servers, lock, run, discover_fn, register_fn):
    assert servers is core._servers and lock is core._lock
    assert run is run_on_loop
    register_fn()
    return {"ok": True, "tools": discover_fn()}
server._mcp_reload = reload
reloaded = server._handle_mcp_action("mcp_reload", {}, "default")
class Task:
    def shutdown(self):
        calls.append("shutdown")
core._servers["probe"] = Task()
stopped = server._shutdown_all_mcp_servers()
import bridge_runtime
bridge_runtime._ensure_agent_imports = lambda: None
discovered = bridge_runtime._discover_bridge_mcp_tools()
print(json.dumps({"listed": listed["ok"], "reloaded": reloaded,
                  "stopped": stopped, "remaining": len(core._servers),
                  "discovered": discovered, "calls": calls}))
`, layout], { cwd: process.cwd(), encoding: 'utf-8', stdio: 'pipe' })
    expect(JSON.parse(output)).toEqual({
      listed: true,
      reloaded: { ok: true, tools: ['mcp_probe_read'] },
      stopped: 1,
      remaining: 0,
      discovered: ['mcp_probe_read'],
      calls: ['register', 'discover', 'loop', 'shutdown', 'discover'],
    })
  })
})
