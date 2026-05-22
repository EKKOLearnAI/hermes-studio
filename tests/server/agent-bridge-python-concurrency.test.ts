import { execFileSync } from 'child_process'
import { describe, expect, it } from 'vitest'

describe('agent bridge Python session concurrency', () => {
  it('routes approval and stream callbacks per concurrent session', () => {
    const script = String.raw`
import contextvars
import importlib.util
import os
import sys
import threading
import time
import types
from pathlib import Path

os.environ["HERMES_AGENT_BRIDGE_WORKER_PROFILE"] = "default"

tools_pkg = types.ModuleType("tools")
tools_pkg.__path__ = []
sys.modules["tools"] = tools_pkg

terminal_tool = types.ModuleType("tools.terminal_tool")
terminal_tool._callback_tls = threading.local()

def set_approval_callback(callback):
    terminal_tool._callback_tls.callback = callback

def _get_approval_callback():
    return getattr(terminal_tool._callback_tls, "callback", None)

terminal_tool.set_approval_callback = set_approval_callback
terminal_tool._get_approval_callback = _get_approval_callback
sys.modules["tools.terminal_tool"] = terminal_tool

approval = types.ModuleType("tools.approval")
approval._session_key = contextvars.ContextVar("approval_session_key", default="")
approval._notify = {}

def set_current_session_key(session_key):
    return approval._session_key.set(session_key or "")

def reset_current_session_key(token):
    approval._session_key.reset(token)

def get_current_session_key(default=""):
    return approval._session_key.get() or default

def register_gateway_notify(session_key, callback):
    approval._notify[session_key] = callback

def unregister_gateway_notify(session_key):
    approval._notify.pop(session_key, None)

approval.set_current_session_key = set_current_session_key
approval.reset_current_session_key = reset_current_session_key
approval.get_current_session_key = get_current_session_key
approval.register_gateway_notify = register_gateway_notify
approval.unregister_gateway_notify = unregister_gateway_notify
sys.modules["tools.approval"] = approval

path = Path("packages/server/src/services/hermes/agent-bridge/hermes_bridge.py")
spec = importlib.util.spec_from_file_location("hermes_bridge", path)
bridge = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = bridge
spec.loader.exec_module(bridge)

barrier = threading.Barrier(2)

class FakeAgent:
    def __init__(self, session_id):
        self.session_id = session_id

    def run_conversation(self, message, **kwargs):
        barrier.wait(timeout=20)
        kwargs["stream_callback"](f"delta:{self.session_id}")
        callback = _get_approval_callback()
        if callback is None:
            raise RuntimeError(f"missing approval callback for {self.session_id}")
        assert get_current_session_key("") == self.session_id
        choice = callback(f"cmd:{self.session_id}", f"desc:{self.session_id}", allow_permanent=False)
        return {
            "messages": [{"role": "assistant", "content": f"done:{self.session_id}:{choice}"}],
            "choice": choice,
            "completed": True,
        }

pool = bridge.AgentPool()
records = {}
threads = []

for sid in ("session-a", "session-b"):
    session = bridge.AgentSession(session_id=sid, agent=FakeAgent(sid))
    run_id = f"run-{sid}"
    record = bridge.RunRecord(run_id=run_id, session_id=sid)
    session.running = True
    session.current_run_id = run_id
    with pool._lock:
        pool._sessions[sid] = session
        pool._runs[run_id] = record
    records[sid] = record
    thread = threading.Thread(
        target=pool._run_chat,
        args=(session, record, f"message:{sid}", None, None, [], "default", False, "api_server"),
        daemon=True,
    )
    threads.append(thread)
    thread.start()

deadline = time.time() + 20
approval_ids = {}
while time.time() < deadline:
    with pool._lock:
        for sid, record in records.items():
            for event in record.events:
                if event.get("event") == "approval.requested":
                    approval_ids[sid] = event["approval_id"]
    if len(approval_ids) == 2:
        break
    time.sleep(0.01)

if set(approval_ids) != {"session-a", "session-b"}:
    diagnostics = {
        sid: {
            "status": record.status,
            "error": record.error,
            "events": record.events,
            "result": record.result,
        }
        for sid, record in records.items()
    }
    raise AssertionError({"approval_ids": approval_ids, "records": diagnostics})

pool.respond_approval(approval_ids["session-b"], "deny")
pool.respond_approval(approval_ids["session-a"], "once")

for thread in threads:
    thread.join(timeout=20)
    assert not thread.is_alive()

assert records["session-a"].status == "complete"
assert records["session-b"].status == "complete"
assert records["session-a"].result["choice"] == "once"
assert records["session-b"].result["choice"] == "deny"
assert records["session-a"].deltas == ["delta:session-a"]
assert records["session-b"].deltas == ["delta:session-b"]

commands = {}
timeouts = {}
for sid, record in records.items():
    for event in record.events:
        if event.get("event") == "approval.requested":
            commands[sid] = event.get("command")
            timeouts[sid] = event.get("timeout_ms")

assert commands == {
    "session-a": "cmd:session-a",
    "session-b": "cmd:session-b",
}
assert timeouts == {
    "session-a": 120000,
    "session-b": 120000,
}

same_session = bridge.AgentSession(session_id="same-session", agent=FakeAgent("same-session"))
same_session.running = True
pool.get_or_create = lambda *args, **kwargs: same_session
try:
    pool.start_chat("same-session", "second")
    raise AssertionError("same-session concurrent run was accepted")
except RuntimeError as exc:
    assert "already running" in str(exc)

class FakeWorker:
    def __init__(self, destroyed):
        self.running = True
        self.destroyed = destroyed
        self.requests = []
        self.stopped = False

    def request(self, req):
        self.requests.append(req)
        return {"ok": True, "destroyed": self.destroyed}

    def stop(self):
        self.running = False
        self.stopped = True

broker = bridge.BridgeBroker("ipc:///tmp/unused.sock")
profile_worker = FakeWorker(2)
broker._workers["default"] = profile_worker
broker._run_profile["run-session-a"] = "default"
broker._session_profile["session-a"] = "default"
broker._approval_profile["approval-a"] = "default"
broker._compression_profile["compression-a"] = "default"

destroy_profile_result = broker.handle({"action": "destroy_profile", "profile": "default"})
assert destroy_profile_result == {"profile": "default", "destroyed": 2}
assert profile_worker.stopped
assert "default" not in broker._workers
assert broker._run_profile == {}
assert broker._session_profile == {}
assert broker._approval_profile == {}
assert broker._compression_profile == {}

worker_a = FakeWorker(1)
worker_b = FakeWorker(3)
broker._workers["a"] = worker_a
broker._workers["b"] = worker_b
broker._run_profile["run-a"] = "a"
broker._session_profile["session-b"] = "b"

destroy_all_result = broker.handle({"action": "destroy_all"})
assert destroy_all_result == {"destroyed": 4}
assert worker_a.stopped
assert worker_b.stopped
assert broker._workers == {}
assert broker._run_profile == {}
assert broker._session_profile == {}
`

    expect(() => execFileSync('python3', ['-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: 'pipe',
    })).not.toThrow()
  })
})
