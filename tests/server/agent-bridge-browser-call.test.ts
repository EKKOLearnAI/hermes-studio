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

describe('agent bridge governed browser calls', () => {
  it('allows only workflow-bound Bilibili navigation and sanitized snapshots', () => {
    const result = runPython(String.raw`
import importlib.util
import json
import os
import sys
import types
from pathlib import Path

os.environ["HERMES_AGENT_BRIDGE_WORKER_PROFILE"] = "default"
path = Path("packages/server/src/services/hermes/agent-bridge/python/hermes_bridge.py")
spec = importlib.util.spec_from_file_location("hermes_bridge", path)
bridge = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = bridge
spec.loader.exec_module(bridge)

calls = []
cleanups = []
response = {"value": None}

def run_browser(task_id, command, args=None, timeout=None):
    calls.append({"task_id": task_id, "command": command, "args": args, "timeout": timeout})
    if response["value"] is not None:
        return response["value"]
    if command == "open":
        return {"success": True, "data": {"url": args[0], "title": "Bilibili"}}
    return {"success": True, "data": {
        "snapshot": "heading Hermes Studio\nlink BV1xx411c7mD by Alice",
        "refs": {"e1": {"role": "link"}},
    }}

browser_tool = types.ModuleType("tools.browser_tool")
browser_tool._run_browser_command = run_browser
browser_tool.cleanup_browser = lambda task_id=None: cleanups.append(task_id)
tools_pkg = types.ModuleType("tools")
tools_pkg.__path__ = []
sys.modules["tools"] = tools_pkg
sys.modules["tools.browser_tool"] = browser_tool

server = bridge.BridgeServer("tcp://127.0.0.1:0")

def navigate(workflow="workflow-proof-1", **changes):
    request = {
        "action": "browser_navigate",
        "profile": "default",
        "workflow_id": workflow,
        "url": "https://search.bilibili.com/all?keyword=Hermes%20Studio&order=totalrank&page=1",
        "timeout": 12,
    }
    request.update(changes)
    return server.handle(request)

def snapshot(workflow="workflow-proof-1", **changes):
    request = {
        "action": "browser_snapshot",
        "profile": "default",
        "workflow_id": workflow,
        "timeout": 9,
    }
    request.update(changes)
    return server.handle(request)

before_navigate = snapshot("workflow-not-open")
success_navigate = navigate()
success_snapshot = snapshot()
stable_task_id = calls[0]["task_id"] == calls[1]["task_id"]

wrong_profile = navigate(profile="other")
private_url = navigate(url="http://127.0.0.1/private")
other_host = navigate(url="https://example.com/video/BV1xx411c7mD")
duplicate_query = navigate(url="https://search.bilibili.com/all?keyword=a&keyword=b&order=totalrank&page=1")
extra_primitive = navigate(ref="@e1")
direct_click = server.handle({
    "action": "browser_click", "profile": "default", "workflow_id": "workflow-proof-1", "ref": "@e1"
})

response["value"] = {"success": True, "data": {
    "url": "http://169.254.169.254/latest/meta-data", "title": "redirect"
}}
unsafe_redirect = navigate("workflow-redirect")

response["value"] = {"success": True, "data": {
    "snapshot": "captcha: please verify you are a robot. secret=must-not-persist",
    "refs": {},
}}
challenge = snapshot()

response["value"] = {"success": True, "data": {
    "snapshot": "heading result\naccess_token=must-not-persist",
    "refs": {},
}}
sensitive = snapshot()

broker = bridge.BridgeBroker("tcp://127.0.0.1:0")
forwarded = []
broker._forward = lambda profile, request, worker_key=None: forwarded.append({
    "profile": profile, "action": request["action"]
}) or {"ok": True}
broker_browser = broker.handle({
    "action": "browser_snapshot", "profile": "default", "workflow_id": "workflow-proof-1", "timeout": 9
})

print(json.dumps({
    "before_navigate": before_navigate,
    "success_navigate": success_navigate,
    "success_snapshot": success_snapshot,
    "stable_task_id": stable_task_id,
    "wrong_profile": wrong_profile,
    "private_url": private_url,
    "other_host": other_host,
    "duplicate_query": duplicate_query,
    "extra_primitive": extra_primitive,
    "direct_click": direct_click,
    "unsafe_redirect": unsafe_redirect,
    "cleanups": cleanups,
    "challenge": challenge,
    "sensitive": sensitive,
    "calls": calls,
    "broker_browser": broker_browser,
    "forwarded": forwarded,
}))
`)

    expect(result.before_navigate).toMatchObject({
      ok: true, action: 'snapshot', status: 'error', error_code: 'BROWSER_SESSION_REOPEN_REQUIRED',
    })
    expect(result.success_navigate).toMatchObject({
      ok: true, action: 'navigate', workflow_id: 'workflow-proof-1', status: 'succeeded',
      error_code: null, title: 'Bilibili',
    })
    expect(result.success_snapshot).toMatchObject({
      ok: true, action: 'snapshot', workflow_id: 'workflow-proof-1', status: 'succeeded',
      error_code: null, element_count: 1,
    })
    expect(result.success_snapshot.snapshot).toContain('BV1xx411c7mD')
    expect(result.stable_task_id).toBe(true)
    expect(result.calls[0]).toMatchObject({ command: 'open', timeout: 12 })
    expect(result.calls[1]).toMatchObject({ command: 'snapshot', args: ['-c'], timeout: 9 })
    expect(result.wrong_profile).toMatchObject({ ok: false, error_code: 'BROWSER_PROFILE_MISMATCH' })
    expect(result.private_url).toMatchObject({ ok: false, error_code: 'BROWSER_URL_REJECTED' })
    expect(result.other_host).toMatchObject({ ok: false, error_code: 'BROWSER_URL_REJECTED' })
    expect(result.duplicate_query).toMatchObject({ ok: false, error_code: 'BROWSER_URL_REJECTED' })
    expect(result.extra_primitive).toMatchObject({ ok: false, error_code: 'BROWSER_REQUEST_INVALID' })
    expect(result.direct_click).toMatchObject({ ok: false, error_code: 'BROWSER_ACTION_FORBIDDEN' })
    expect(result.unsafe_redirect).toMatchObject({ ok: false, error_code: 'BROWSER_REDIRECT_REJECTED' })
    expect(result.cleanups).toHaveLength(1)
    expect(result.challenge).toMatchObject({
      ok: true, status: 'waiting_user', error_code: 'BROWSER_HUMAN_VERIFICATION_REQUIRED',
    })
    expect(result.challenge).not.toHaveProperty('snapshot')
    expect(result.sensitive).toMatchObject({ ok: true, status: 'error', error_code: 'BROWSER_RESULT_INVALID' })
    expect(JSON.stringify(result)).not.toContain('must-not-persist')
    expect(result.calls.every((call: { command: string }) => ['open', 'snapshot'].includes(call.command))).toBe(true)
    expect(result.broker_browser).toEqual({ ok: true })
    expect(result.forwarded).toEqual([{ profile: 'default', action: 'browser_snapshot' }])
  })

  it('sends exact internal client requests with bounded timeouts and no task id', async () => {
    const { AgentBridgeClient } = await import('../../packages/server/src/services/hermes/agent-bridge/client')
    const client = new AgentBridgeClient({ endpoint: 'tcp://127.0.0.1:1', connectRetryMs: 0, timeoutMs: 1 })
    const request = vi.spyOn(client, 'request').mockResolvedValue({
      ok: true, action: 'navigate', workflow_id: 'workflow-proof-1', session_id: 'browser-session-safe',
      status: 'succeeded', error_code: null,
    })

    await client.browserNavigate(
      'workflow-proof-1', 'https://www.bilibili.com/video/BV1xx411c7mD', 'default', 120_000,
    )
    await client.browserSnapshot('workflow-proof-1', 'default', 1)

    expect(request).toHaveBeenNthCalledWith(1, {
      action: 'browser_navigate', workflow_id: 'workflow-proof-1',
      url: 'https://www.bilibili.com/video/BV1xx411c7mD', profile: 'default', timeout: 60,
    }, { timeoutMs: 75_000 })
    expect(request).toHaveBeenNthCalledWith(2, {
      action: 'browser_snapshot', workflow_id: 'workflow-proof-1', profile: 'default', timeout: 5,
    }, { timeoutMs: 20_000 })
    expect(JSON.stringify(request.mock.calls)).not.toContain('task_id')
  })
})
