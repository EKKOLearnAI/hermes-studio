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
approval._session_approved = {}
approval._permanent_approved = set()
approval._saved_permanent = set()
approval._check_execute_code_calls = []

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

def is_approved(session_key, pattern_key):
    return (
        pattern_key in approval._permanent_approved or
        pattern_key in approval._session_approved.get(session_key, set())
    )

def approve_session(session_key, pattern_key):
    approval._session_approved.setdefault(session_key, set()).add(pattern_key)

def approve_permanent(pattern_key):
    approval._permanent_approved.add(pattern_key)

def save_permanent_allowlist(patterns):
    approval._saved_permanent = set(patterns)

def load_permanent_allowlist():
    return set(approval._permanent_approved)

def check_execute_code_guard(code, env_type):
    approval._check_execute_code_calls.append((code, env_type))
    return {"approved": False, "message": "upstream prompt"}

approval.set_current_session_key = set_current_session_key
approval.reset_current_session_key = reset_current_session_key
approval.get_current_session_key = get_current_session_key
approval.register_gateway_notify = register_gateway_notify
approval.unregister_gateway_notify = unregister_gateway_notify
approval.resolve_gateway_approval = resolve_gateway_approval
approval.is_approved = is_approved
approval.approve_session = approve_session
approval.approve_permanent = approve_permanent
approval.save_permanent_allowlist = save_permanent_allowlist
approval.load_permanent_allowlist = load_permanent_allowlist
approval.check_execute_code_guard = check_execute_code_guard
sys.modules["tools.approval"] = approval

path = Path("packages/server/src/services/hermes/agent-bridge/python/hermes_bridge.py")
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
  it('hot-switches a loaded idle session model without recreating the session', () => {
    runPython(String.raw`
${harness}

def fake_resolve_runtime(model, provider=None):
    return {
        "provider": provider or "openai",
        "base_url": f"https://{provider or 'openai'}.example/v1",
        "api_key": f"key:{model}",
        "api_mode": "chat_completions",
    }

bridge._resolve_runtime = fake_resolve_runtime
pool, _fake_db = make_pool()

class SwitchableAgent:
    def __init__(self):
        self.model = "old-model"
        self.provider = "openai"
        self.base_url = "https://old.example/v1"
        self.api_key = "old-key"
        self.api_mode = "chat_completions"
        self.switch_calls = []

    def switch_model(self, **kwargs):
        self.switch_calls.append(kwargs)
        self.model = kwargs["new_model"]
        self.provider = kwargs["new_provider"]
        self.base_url = kwargs["base_url"]
        self.api_key = kwargs["api_key"]
        self.api_mode = kwargs["api_mode"]

agent = SwitchableAgent()
session = bridge.AgentSession(
    session_id="session-model",
    agent=agent,
    config={"profile": "default", "model": "old-model", "provider": "openai"},
)
pool._sessions["session-model"] = session

result = pool.switch_session_model("session-model", "new-model", "anthropic", "default")

assert result["switched"] is True
assert pool._sessions["session-model"] is session
assert agent.switch_calls == [{
    "new_model": "new-model",
    "new_provider": "anthropic",
    "api_key": "key:new-model",
    "base_url": "https://anthropic.example/v1",
    "api_mode": "chat_completions",
}]
assert session.config["model"] == "new-model"
assert session.config["provider"] == "anthropic"
assert "pending_model_switch_note" in session.config
`)
  })

  it('defers a loaded session model switch while a run is active and applies it after completion', () => {
    runPython(String.raw`
${harness}

def fake_resolve_runtime(model, provider=None):
    return {
        "provider": provider or "openai",
        "base_url": f"https://{provider or 'openai'}.example/v1",
        "api_key": f"key:{model}",
        "api_mode": "chat_completions",
    }

bridge._resolve_runtime = fake_resolve_runtime
pool, _fake_db = make_pool()
release = threading.Event()

class RunningAgent:
    def __init__(self):
        self.model = "old-model"
        self.provider = "openai"
        self.switch_calls = []

    def switch_model(self, **kwargs):
        self.switch_calls.append(kwargs)
        self.model = kwargs["new_model"]
        self.provider = kwargs["new_provider"]

    def run_conversation(self, message, **kwargs):
        release.wait(timeout=5)
        return {"messages": [{"role": "assistant", "content": "done"}]}

agent = RunningAgent()
session, record, thread = start_manual_run(pool, "running-model", agent)
session.config.update({"profile": "default", "model": "old-model", "provider": "openai"})
assert wait_for(lambda: session.running)

result = pool.switch_session_model("running-model", "new-model", "anthropic", "default")
assert result["deferred"] is True
assert agent.switch_calls == []

release.set()
thread.join(timeout=5)

assert record.status == "complete"
assert agent.switch_calls == [{
    "new_model": "new-model",
    "new_provider": "anthropic",
    "api_key": "key:new-model",
    "base_url": "https://anthropic.example/v1",
    "api_mode": "chat_completions",
}]
assert session.config["model"] == "new-model"
assert session.config["provider"] == "anthropic"
assert "pending_model_switch" not in session.config
`)
  })

  it('syncs generated result tail to the session DB when the agent crashes after generation', () => {
    runPython(String.raw`
${harness}

class CrashingAgent:
    def run_conversation(self, message, **kwargs):
        self.messages = [
            {"role": "user", "content": message},
            {"role": "assistant", "content": "assistant survived"},
        ]
        raise RuntimeError("late post-processing failure")

pool, fake_db = make_pool()
_session, record, thread = start_manual_run(pool, "tail-sync", CrashingAgent())
thread.join(timeout=5)

assert record.status == "error"
messages = fake_db.get_messages("tail-sync")
assert [(msg["role"], msg["content"]) for msg in messages] == [
    ("user", "message:tail-sync"),
    ("assistant", "assistant survived"),
]
`)
  })

  it('only appends missing generated tail messages when the session DB is partially flushed', () => {
    runPython(String.raw`
${harness}

class PartiallyFlushedAgent:
    def __init__(self, db):
        self.db = db

    def run_conversation(self, message, **kwargs):
        self.db.append_message("partial-tail-sync", "assistant", "already flushed")
        self.messages = [
            {"role": "user", "content": message},
            {"role": "assistant", "content": "already flushed"},
            {"role": "tool", "content": "missing tool result", "tool_name": "demo"},
        ]
        raise RuntimeError("late post-processing failure")

pool, fake_db = make_pool()
_session, record, thread = start_manual_run(pool, "partial-tail-sync", PartiallyFlushedAgent(fake_db))
thread.join(timeout=5)

assert record.status == "error"
messages = fake_db.get_messages("partial-tail-sync")
assert [(msg["role"], msg["content"]) for msg in messages] == [
    ("user", "message:partial-tail-sync"),
    ("assistant", "already flushed"),
    ("tool", "missing tool result"),
]
`)
  })

  it('remembers execute_code approvals inside the bridge without patching upstream files', () => {
    runPython(String.raw`
${harness}

pool, _fake_db = make_pool()

notify = pool._gateway_approval_notify("session-a")
notify({
    "command": "execute_code <<'PY'\nprint(1)\nPY",
    "description": "execute_code script execution",
    "pattern_key": "execute_code",
    "pattern_keys": ["execute_code"],
})
approval_id = next(iter(pool._gateway_approval_requests.keys()))
result = pool.respond_approval(approval_id, "session")
assert result["resolved"] is True
assert approval.is_approved("session-a", "execute_code") is True
assert approval._saved_permanent == set()

notify = pool._gateway_approval_notify("session-b")
notify({
    "command": "execute_code <<'PY'\nprint(2)\nPY",
    "description": "execute_code script execution",
    "pattern_key": "execute_code",
    "pattern_keys": ["execute_code"],
})
approval_id = next(iter(pool._gateway_approval_requests.keys()))
result = pool.respond_approval(approval_id, "always")
assert result["resolved"] is True
assert approval.is_approved("session-b", "execute_code") is True
assert "execute_code" in approval._permanent_approved
assert "execute_code" in approval._saved_permanent

bridge._install_execute_code_approval_memory_patch()
token = approval.set_current_session_key("session-c")
try:
    approval.approve_session("session-c", "execute_code")
    check_result = approval.check_execute_code_guard("print(3)", "local")
    assert check_result["approved"] is True
    assert approval._check_execute_code_calls == []
finally:
    approval.reset_current_session_key(token)
`)
  })

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

  it('does not start a worker for unloaded broker status checks', () => {
    runPython(String.raw`
${harness}

broker = bridge.BridgeBroker("ipc:///tmp/unused.sock")
resp = broker.handle({
    "action": "status_if_loaded",
    "session_id": "session-a",
    "profile": "default",
})

assert resp["session_id"] == "session-a"
assert resp["running"] is False
assert resp["loaded"] is False
assert broker._workers == {}
`)
  })

  it('forwards unloaded-safe status checks to an existing routed worker', () => {
    runPython(String.raw`
${harness}

class StatusWorker:
    running = True
    pid = 12345
    endpoint = "ipc:///tmp/worker.sock"
    last_used_at = 12.5

    def __init__(self):
        self.profile = "default"
        self.key = "default"
        self.requests = []

    def request(self, req, timeout=None):
        self.requests.append(req)
        assert req["action"] == "status"
        assert "worker_key" not in req
        return {
            "ok": True,
            "session_id": req["session_id"],
            "exists": True,
            "running": True,
            "current_run_id": "run-a",
        }

broker = bridge.BridgeBroker("ipc:///tmp/unused.sock")
worker = StatusWorker()
broker._workers["default"] = worker
broker._session_profile["session-a"] = "default"
broker._session_worker_key["session-a"] = "default"

resp = broker.handle({
    "action": "status_if_loaded",
    "session_id": "session-a",
    "profile": "default",
})

assert resp["running"] is True
assert resp["current_run_id"] == "run-a"
assert resp["loaded"] is True
assert len(worker.requests) == 1
assert len(broker._workers) == 1
`)
  })

  it('does not record a route for missing sessions during unloaded-safe status checks', () => {
    runPython(String.raw`
${harness}

class StatusWorker:
    running = True
    pid = 12345
    endpoint = "ipc:///tmp/worker.sock"
    last_used_at = 12.5
    profile = "default"
    key = "default"

    def request(self, req, timeout=None):
        return {
            "ok": True,
            "session_id": req["session_id"],
            "exists": False,
            "running": False,
            "message_count": 0,
        }

broker = bridge.BridgeBroker("ipc:///tmp/unused.sock")
broker._workers["default"] = StatusWorker()

resp = broker.handle({
    "action": "status_if_loaded",
    "session_id": "missing-session",
    "profile": "default",
})

assert resp["exists"] is False
assert resp["loaded"] is True
assert broker._session_profile == {}
assert broker._session_worker_key == {}
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

  it('does not persist session-level approval for repeated memory write prompts', () => {
    runPython(String.raw`
${harness}

pool, _fake_db = make_pool()
callback = pool._approval_callback("session-a")
result = {}

def first_prompt():
    result["first"] = callback("memory text", "Save to memory: add to memory", allow_permanent=False)

thread = threading.Thread(target=first_prompt)
thread.start()

deadline = time.time() + 5
approval_id = None
while time.time() < deadline:
    with pool._lock:
        approval_id = next(iter(pool._approval_requests), None)
    if approval_id:
        break
    time.sleep(0.01)

assert approval_id is not None
assert pool.respond_approval(approval_id, "session") == {
    "approval_id": approval_id,
    "resolved": True,
    "choice": "session",
}
thread.join(timeout=5)
assert result["first"] == "session"

second_result = {}
def second_prompt():
    second_result["choice"] = callback("memory text 2", "Save to memory: add to memory", allow_permanent=False)

thread = threading.Thread(target=second_prompt)
thread.start()
deadline = time.time() + 5
approval_id = None
while time.time() < deadline:
    with pool._lock:
        approval_id = next(iter(pool._approval_requests), None)
    if approval_id:
        break
    time.sleep(0.01)

assert approval_id is not None
pool.respond_approval(approval_id, "once")
thread.join(timeout=5)
assert second_result["choice"] == "once"
`)
  })

  it('keeps bound approval session when Hermes propagates callback to tool workers', () => {
    runPython(String.raw`
${harness}

pool, _fake_db = make_pool()
pool._install_approval_dispatcher_for_current_thread("session-a")
parent_callback = terminal_tool._get_approval_callback()
assert parent_callback is not None

result = {}
def worker_prompt():
    # Hermes propagates the terminal approval callback object to worker threads,
    # but it does not propagate bridge_pool._run_context because that is a
    # bridge-local threading.local(). The callback itself must carry session-a.
    assert getattr(pool._run_context, "session_id", "") == ""
    result["first"] = parent_callback("memory text", "Save to memory: add preference", allow_permanent=False)

thread = threading.Thread(target=worker_prompt)
thread.start()

deadline = time.time() + 5
approval_id = None
while time.time() < deadline:
    with pool._lock:
        approval_id = next(iter(pool._approval_requests), None)
    if approval_id:
        break
    time.sleep(0.01)

assert approval_id is not None
pool.respond_approval(approval_id, "session")
thread.join(timeout=5)
assert result["first"] == "session"
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
    created["encoding"] = kwargs.get("encoding")
    created["errors"] = kwargs.get("errors")
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
assert created["encoding"] == "utf-8"
assert created["errors"] == "replace"

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
