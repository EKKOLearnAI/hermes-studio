import { execFileSync } from 'child_process'
import { describe, it } from 'vitest'

function runPython(script: string): void {
  try {
    execFileSync('python3', ['-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: 'pipe',
    })
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string }
    throw new Error([
      err.message || 'Python bridge concurrency script failed',
      err.stdout ? `stdout:\n${err.stdout}` : '',
      err.stderr ? `stderr:\n${err.stderr}` : '',
    ].filter(Boolean).join('\n\n'))
  }
}

const harness = String.raw`
import contextvars
import importlib.util
import json
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
approval._resolved_gateway = []

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

def resolve_gateway_approval(session_key, choice):
    approval._resolved_gateway.append((session_key, choice))
    return 1

approval.set_current_session_key = set_current_session_key
approval.reset_current_session_key = reset_current_session_key
approval.get_current_session_key = get_current_session_key
approval.register_gateway_notify = register_gateway_notify
approval.unregister_gateway_notify = unregister_gateway_notify
approval.resolve_gateway_approval = resolve_gateway_approval
sys.modules["tools.approval"] = approval

path = Path("packages/server/src/services/hermes/agent-bridge/hermes_bridge.py")
spec = importlib.util.spec_from_file_location("hermes_bridge", path)
bridge = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = bridge
spec.loader.exec_module(bridge)

class FakeDb:
    def __init__(self):
        self.lock = threading.Lock()
        self.messages = {}
        self.sessions = set()

    def create_session(self, session_id, **kwargs):
        with self.lock:
            self.sessions.add(session_id)
            self.messages.setdefault(session_id, [])

    def get_messages(self, session_id):
        with self.lock:
            return list(self.messages.get(session_id, []))

    def append_message(self, session_id, role, content=None, **kwargs):
        with self.lock:
            self.messages.setdefault(session_id, []).append({
                "role": role,
                "content": content,
                **kwargs,
            })

class FakeDbHolder:
    error = None

    def __init__(self, db):
        self.db = db

    def get_for_profile(self, profile):
        return self.db

def make_pool():
    pool = bridge.AgentPool()
    fake_db = FakeDb()
    pool._db = FakeDbHolder(fake_db)
    return pool, fake_db

def start_manual_run(pool, session_id, agent, message=None):
    session = bridge.AgentSession(session_id=session_id, agent=agent)
    run_id = f"run-{session_id}"
    record = bridge.RunRecord(run_id=run_id, session_id=session_id)
    session.running = True
    session.current_run_id = run_id
    with pool._lock:
        pool._sessions[session_id] = session
        pool._runs[run_id] = record
    thread = threading.Thread(
        target=pool._run_chat,
        args=(session, record, message or f"message:{session_id}", None, None, [], "default", False, "api_server"),
        daemon=True,
    )
    thread.start()
    return session, record, thread

def wait_for(condition, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if condition():
            return True
        time.sleep(0.01)
    return False
`

describe('agent bridge Python session concurrency', () => {
  it('routes terminal/gateway approvals and stream callbacks per concurrent session', () => {
    runPython(String.raw`
${harness}

barrier = threading.Barrier(2)
os.environ["HERMES_EXEC_ASK"] = "preexisting-exec-ask"

class FakeAgent:
    def __init__(self, session_id):
        self.session_id = session_id

    def run_conversation(self, message, **kwargs):
        barrier.wait(timeout=20)
        notify = approval._notify.get(self.session_id)
        if notify is None:
            raise RuntimeError(f"missing gateway notify for {self.session_id}")
        notify({
            "command": f"gateway:{self.session_id}",
            "description": f"gateway-desc:{self.session_id}",
        })
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

pool, fake_db = make_pool()
records = {}
threads = []

for sid in ("session-a", "session-b"):
    _session, record, thread = start_manual_run(pool, sid, FakeAgent(sid))
    records[sid] = record
    threads.append(thread)

terminal_approval_ids = {}
gateway_approval_ids = {}
def approvals_ready():
    with pool._lock:
        for sid, record in records.items():
            for event in record.events:
                if event.get("event") != "approval.requested":
                    continue
                command = event.get("command")
                if command == f"cmd:{sid}":
                    terminal_approval_ids[sid] = event["approval_id"]
                if command == f"gateway:{sid}":
                    gateway_approval_ids[sid] = event["approval_id"]
    return (
        set(terminal_approval_ids) == {"session-a", "session-b"} and
        set(gateway_approval_ids) == {"session-a", "session-b"}
    )

if not wait_for(approvals_ready):
    diagnostics = {
        sid: {
            "status": record.status,
            "error": record.error,
            "events": record.events,
            "result": record.result,
        }
        for sid, record in records.items()
    }
    raise AssertionError({
        "terminal_approval_ids": terminal_approval_ids,
        "gateway_approval_ids": gateway_approval_ids,
        "records": diagnostics,
    })

assert os.environ.get("HERMES_EXEC_ASK") == "1"
assert pool._exec_ask_depth == 2

pool.respond_approval(gateway_approval_ids["session-b"], "always")
pool.respond_approval(gateway_approval_ids["session-a"], "session")
pool.respond_approval(terminal_approval_ids["session-b"], "deny")
pool.respond_approval(terminal_approval_ids["session-a"], "once")

for thread in threads:
    thread.join(timeout=20)
    assert not thread.is_alive()

assert records["session-a"].status == "complete"
assert records["session-b"].status == "complete"
assert records["session-a"].result["choice"] == "once"
assert records["session-b"].result["choice"] == "deny"
assert records["session-a"].deltas == ["delta:session-a"]
assert records["session-b"].deltas == ["delta:session-b"]
assert fake_db.get_messages("session-a")[0]["content"] == "message:session-a"
assert fake_db.get_messages("session-b")[0]["content"] == "message:session-b"
assert os.environ.get("HERMES_EXEC_ASK") == "preexisting-exec-ask"
assert pool._exec_ask_depth == 0
assert pool._approval_handlers == {}
assert approval._notify == {}
assert sorted(approval._resolved_gateway) == [
    ("session-a", "session"),
    ("session-b", "always"),
]

terminal_commands = {}
gateway_commands = {}
timeouts = {}
for sid, record in records.items():
    for event in record.events:
        if event.get("event") != "approval.requested":
            continue
        command = event.get("command")
        if command == f"cmd:{sid}":
            terminal_commands[sid] = command
            timeouts[sid] = event.get("timeout_ms")
        if command == f"gateway:{sid}":
            gateway_commands[sid] = command

assert terminal_commands == {
    "session-a": "cmd:session-a",
    "session-b": "cmd:session-b",
}
assert gateway_commands == {
    "session-a": "gateway:session-a",
    "session-b": "gateway:session-b",
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
    def __init__(self, destroyed, profile="default", key="default"):
        self.running = True
        self.destroyed = destroyed
        self.profile = profile
        self.key = key
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
broker._run_worker_key["run-session-a"] = "default"
broker._running_run_profile["run-session-a"] = "default"
broker._running_run_worker_key["run-session-a"] = "default"
broker._session_profile["session-a"] = "default"
broker._session_worker_key["session-a"] = "default"
broker._approval_profile["approval-a"] = "default"
broker._approval_worker_key["approval-a"] = "default"
broker._compression_profile["compression-a"] = "default"
broker._compression_worker_key["compression-a"] = "default"

destroy_profile_result = broker.handle({"action": "destroy_profile", "profile": "default"})
assert destroy_profile_result == {"profile": "default", "destroyed": 2}
assert profile_worker.stopped
assert "default" not in broker._workers
assert broker._run_profile == {}
assert broker._run_worker_key == {}
assert broker._running_run_profile == {}
assert broker._running_run_worker_key == {}
assert broker._session_profile == {}
assert broker._session_worker_key == {}
assert broker._approval_profile == {}
assert broker._approval_worker_key == {}
assert broker._compression_profile == {}
assert broker._compression_worker_key == {}

worker_a = FakeWorker(1, "default", "a")
worker_b = FakeWorker(3, "work", "b")
broker._workers["a"] = worker_a
broker._workers["b"] = worker_b
broker._run_profile["run-a"] = "default"
broker._run_worker_key["run-a"] = "a"
broker._running_run_profile["run-a"] = "default"
broker._running_run_worker_key["run-a"] = "a"
broker._session_profile["session-b"] = "work"
broker._session_worker_key["session-b"] = "b"

destroy_all_result = broker.handle({"action": "destroy_all"})
assert destroy_all_result == {"destroyed": 4}
assert worker_a.stopped
assert worker_b.stopped
assert broker._workers == {}
assert broker._run_profile == {}
assert broker._run_worker_key == {}
assert broker._running_run_profile == {}
assert broker._running_run_worker_key == {}
assert broker._session_profile == {}
assert broker._session_worker_key == {}
`)
  })

  it('builds broker ping metrics without calling profile workers', () => {
    runPython(String.raw`
${harness}

class PingWorker:
    running = True
    pid = 12345
    endpoint = "ipc:///tmp/worker.sock"
    last_used_at = 12.5

    def request(self, req):
        raise AssertionError("broker ping must not forward to worker")

broker = bridge.BridgeBroker("ipc:///tmp/broker.sock")
broker._workers["default"] = PingWorker()
broker._session_profile["session-a"] = "default"
broker._running_run_profile["run-a"] = "default"

resp = broker.handle({"action": "ping"})
assert resp["workers"] == {"default": True}
assert resp["worker_details"]["default"]["pid"] == 12345
assert resp["active_sessions"] == 1
assert resp["running_sessions"] == 1
assert resp["sessions_by_profile"] == {"default": 1}
assert resp["running_sessions_by_profile"] == {"default": 1}
`)
  })

  it('routes worker-keyed broker requests without stopping the worker on session destroy', () => {
    runPython(String.raw`
${harness}

class RoutedWorker:
    running = True
    pid = 12345
    endpoint = "ipc:///tmp/worker.sock"
    last_used_at = 12.5

    def __init__(self, profile, key):
        self.profile = profile
        self.key = key
        self.requests = []
        self.stopped = False

    def request(self, req, timeout=None):
        self.requests.append(req)
        action = req.get("action")
        if action == "chat":
            return {"ok": True, "run_id": "run-compress", "session_id": req["session_id"], "status": "running"}
        if action == "get_output":
            return {"ok": True, "run_id": req["run_id"], "session_id": "compress-temp", "status": "complete", "done": True}
        if action == "destroy":
            return {"ok": True, "session_id": req["session_id"], "destroyed": True}
        raise AssertionError(f"unexpected action: {action}")

    def stop(self):
        self.stopped = True

broker = bridge.BridgeBroker("ipc:///tmp/unused.sock")
worker = RoutedWorker("default", "default:compression:session-a")
broker._workers[worker.key] = worker

chat_resp = broker.handle({
    "action": "chat",
    "session_id": "compress-temp",
    "profile": "default",
    "worker_key": worker.key,
    "message": "summarize",
})
assert chat_resp["run_id"] == "run-compress"
assert worker.requests[-1]["profile"] == "default"
assert "worker_key" not in worker.requests[-1]

broker.handle({"action": "get_output", "run_id": "run-compress"})
assert worker.requests[-1]["action"] == "get_output"

destroy_resp = broker.handle({
    "action": "destroy",
    "session_id": "compress-temp",
    "profile": "default",
    "worker_key": worker.key,
})
assert destroy_resp["destroyed"] is True
assert worker.requests[-1]["action"] == "destroy"
assert not worker.stopped
assert worker.key in broker._workers
assert "compress-temp" not in broker._session_profile
assert "compress-temp" not in broker._session_worker_key
`)
  })

  it('namespaces profile worker endpoints by broker endpoint', () => {
    runPython(String.raw`
${harness}

prod_endpoint = bridge._worker_endpoint("default", "ipc:///tmp/hermes-agent-bridge.sock")
preview_endpoint = bridge._worker_endpoint("default", "ipc:///tmp/hermes-web-ui-preview/agent-bridge.sock")
assert prod_endpoint != preview_endpoint
assert prod_endpoint == bridge._worker_endpoint("default", "ipc:///tmp/hermes-agent-bridge.sock")

prod_broker = bridge.BridgeBroker("ipc:///tmp/hermes-agent-bridge.sock")
preview_broker = bridge.BridgeBroker("ipc:///tmp/hermes-web-ui-preview/agent-bridge.sock")
prod_worker = prod_broker._worker_for_profile("default")
preview_worker = preview_broker._worker_for_profile("default")
assert prod_worker.endpoint != preview_worker.endpoint
`)
  })

  it('allows worker transport to be selected with environment variables', () => {
    runPython(String.raw`
${harness}

os.environ.pop("HERMES_AGENT_BRIDGE_WORKER_TRANSPORT", None)
os.environ.pop("HERMES_AGENT_BRIDGE_WORKER_PORT_BASE", None)

default_endpoint = bridge._worker_endpoint("default", "ipc:///tmp/hermes-agent-bridge.sock")
if os.name == "nt":
    assert default_endpoint.startswith("tcp://127.0.0.1:")
else:
    assert default_endpoint.startswith("ipc://")

os.environ["HERMES_AGENT_BRIDGE_WORKER_TRANSPORT"] = "tcp"
os.environ["HERMES_AGENT_BRIDGE_WORKER_PORT_BASE"] = "19650"
tcp_endpoint = bridge._worker_endpoint("default", "ipc:///tmp/hermes-agent-bridge.sock")
assert tcp_endpoint.startswith("tcp://127.0.0.1:")
assert int(tcp_endpoint.rsplit(":", 1)[1]) >= 19650
assert int(tcp_endpoint.rsplit(":", 1)[1]) < 20650

os.environ["HERMES_AGENT_BRIDGE_WORKER_TRANSPORT"] = "ipc"
ipc_endpoint = bridge._worker_endpoint("default", "ipc:///tmp/hermes-agent-bridge.sock")
assert ipc_endpoint.startswith("ipc://")

os.environ.pop("HERMES_AGENT_BRIDGE_WORKER_TRANSPORT", None)
os.environ.pop("HERMES_AGENT_BRIDGE_WORKER_PORT_BASE", None)
`)
  })

  it('restores approval env and clears handlers when a run fails', () => {
    runPython(String.raw`
${harness}

os.environ.pop("HERMES_EXEC_ASK", None)

class FailingAgent:
    def run_conversation(self, message, **kwargs):
        assert os.environ.get("HERMES_EXEC_ASK") == "1"
        assert _get_approval_callback() is not None
        raise RuntimeError("boom")

pool, fake_db = make_pool()
session, record, thread = start_manual_run(pool, "error-session", FailingAgent())
thread.join(timeout=20)
assert not thread.is_alive()

assert record.status == "error"
assert "boom" in (record.error or "")
assert session.running is False
assert session.current_run_id is None
assert "HERMES_EXEC_ASK" not in os.environ
assert pool._exec_ask_depth == 0
assert pool._exec_ask_previous is None
assert pool._approval_handlers == {}
assert approval._notify == {}
assert fake_db.get_messages("error-session")[0]["content"] == "message:error-session"
`)
  })

  it('fails closed when approval dispatch loses run thread context', () => {
    runPython(String.raw`
${harness}

pool, _fake_db = make_pool()
calls = []

def handler(command, description, *, allow_permanent=True):
    calls.append((command, description, allow_permanent))
    return "once"

with pool._lock:
    pool._approval_handlers["session-a"] = handler

assert pool._approval_dispatcher("cmd", "desc") == "deny"
assert calls == []

pool._run_context.session_id = "missing-session"
assert pool._approval_dispatcher("cmd", "desc") == "deny"
assert calls == []

pool._run_context.session_id = "session-a"
assert pool._approval_dispatcher("cmd", "desc", allow_permanent=False) == "once"
assert calls == [("cmd", "desc", False)]
`)
  })

  it('cleans broker workers and wires worker parent watchdog state', () => {
    runPython(String.raw`
${harness}

class FakeWorker:
    def __init__(self):
        self.running = True
        self.stopped = False

    def stop(self):
        self.running = False
        self.stopped = True

broker = bridge.BridgeBroker("ipc:///tmp/unused.sock")
worker = FakeWorker()
broker._workers["default"] = worker
broker._run_profile["run-a"] = "default"
broker._running_run_profile["run-a"] = "default"
broker._session_profile["session-a"] = "default"
broker._approval_profile["approval-a"] = "default"
broker._compression_profile["compression-a"] = "default"

broker.stop()
assert broker._stop.is_set()
assert worker.stopped
assert broker._workers == {}
assert broker._run_profile == {}
assert broker._running_run_profile == {}
assert broker._session_profile == {}
assert broker._approval_profile == {}
assert broker._compression_profile == {}

created = {}

class FakeProcess:
    stdout = None
    stderr = None

    def poll(self):
        return None

def fake_popen(args, **kwargs):
    created["args"] = args
    created["env"] = kwargs["env"]
    return FakeProcess()

original_popen = bridge.subprocess.Popen
original_getpid = bridge.os.getpid
try:
    bridge.subprocess.Popen = fake_popen
    bridge.os.getpid = lambda: 4242
    proc_worker = bridge.WorkerProcess("default:compression:session-a", "default", "ipc:///tmp/worker.sock", "/agent", "/home")
    proc_worker._pipe_stderr = lambda: None
    proc_worker._wait_ready = lambda: None
    proc_worker.start()
finally:
    bridge.subprocess.Popen = original_popen
    bridge.os.getpid = original_getpid

assert created["env"]["HERMES_AGENT_BRIDGE_BROKER_PID"] == "4242"
assert created["env"]["HERMES_AGENT_BRIDGE_WORKER_PROFILE"] == "default"

stop_event = threading.Event()
seen_pids = []
original_process_exists = bridge._process_exists
try:
    bridge._process_exists = lambda pid: seen_pids.append(pid) and False
    bridge._start_parent_process_watchdog(12345, stop_event, "test", interval=0.01)
    assert wait_for(stop_event.is_set, timeout=2)
finally:
    bridge._process_exists = original_process_exists

assert seen_pids == [12345]
`)
  })

  it('handles broker ping while another broker request is blocked', () => {
    runPython(String.raw`
${harness}

class BlockingBroker(bridge.BridgeBroker):
    def handle(self, req):
        if req.get("action") == "block":
            time.sleep(0.4)
            return {"blocked": True}
        return super().handle(req)

class MemoryConn:
    def __init__(self, req):
        self.request = (json.dumps(req) + "\n").encode("utf-8")
        self.response = b""
        self.closed = False

    def recv(self, size):
        if not self.request:
            return b""
        chunk = self.request[:size]
        self.request = self.request[size:]
        return chunk

    def sendall(self, payload):
        self.response += payload

    def close(self):
        self.closed = True

broker = BlockingBroker("ipc:///tmp/unused.sock")
blocking_conn = MemoryConn({"action": "block"})
thread = threading.Thread(target=broker._handle_connection, args=(blocking_conn,))
thread.start()
time.sleep(0.05)

ping_conn = MemoryConn({"action": "ping"})
broker._handle_connection(ping_conn)
ping_resp = json.loads(ping_conn.response.decode("utf-8"))
assert ping_resp["ok"] is True, ping_resp
assert ping_resp["pong"] is True, ping_resp
assert ping_conn.closed is True, ping_conn.closed

thread.join(timeout=2)
assert not thread.is_alive(), blocking_conn.response
blocked_resp = json.loads(blocking_conn.response.decode("utf-8"))
assert blocked_resp["ok"] is True, blocked_resp
assert blocked_resp["blocked"] is True, blocked_resp
`)
  })

  it('extends profile worker request timeout from wait requests', () => {
    runPython(String.raw`
${harness}

broker = bridge.BridgeBroker("ipc:///tmp/unused.sock")
assert broker._worker_request_timeout({"action": "chat"}) == bridge.WorkerProcess.REQUEST_TIMEOUT_SECONDS
assert broker._worker_request_timeout({"action": "chat", "timeout": 60}) == bridge.WorkerProcess.REQUEST_TIMEOUT_SECONDS
assert broker._worker_request_timeout({"action": "chat", "timeout": 300}) == 310

captured = {}
worker = bridge.WorkerProcess("default", "default", "ipc:///tmp/worker.sock", None, None)
worker.start = lambda: None
original_send = bridge._send_bridge_request
try:
    def fake_send(endpoint, req, timeout):
        captured["endpoint"] = endpoint
        captured["req"] = req
        captured["timeout"] = timeout
        return {"ok": True}
    bridge._send_bridge_request = fake_send
    response = worker.request({"action": "chat"}, 310)
finally:
    bridge._send_bridge_request = original_send

assert response["ok"] is True, response
assert captured["endpoint"] == "ipc:///tmp/worker.sock", captured
assert captured["req"] == {"action": "chat"}, captured
assert captured["timeout"] == 310, captured
`)
  })

  it('awaits MCP server shutdown without holding the MCP registry lock', () => {
    runPython(String.raw`
${harness}

import asyncio

lock = threading.Lock()
servers = {}
events = []

class FakeMcpTask:
    async def shutdown(self):
        events.append("shutdown-started")
        acquired = lock.acquire(blocking=False)
        events.append(("lock-free-during-shutdown", acquired))
        if acquired:
            lock.release()
        await asyncio.sleep(0)
        events.append("shutdown-finished")

task = FakeMcpTask()
servers["github"] = task

def run_on_mcp_loop(factory, timeout=30):
    events.append(("timeout", timeout))
    asyncio.run(factory())

result = bridge.BridgeServer._shutdown_mcp_server(
    "github",
    servers,
    lock,
    run_on_mcp_loop,
)

assert result is True, result
assert "github" not in servers, servers
assert events == [
    ("timeout", 15),
    "shutdown-started",
    ("lock-free-during-shutdown", True),
    "shutdown-finished",
], events
`)
  })
})
