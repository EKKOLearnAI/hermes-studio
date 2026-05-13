#!/usr/bin/env python3
"""Hermes in-process agent bridge.

This service intentionally lives outside the existing Web UI chat path. It
imports hermes-agent from HERMES_AGENT_ROOT (default: ~/.hermes/hermes-agent),
keeps AIAgent instances in memory by session_id, and exposes a small newline-
delimited JSON request/response protocol over a local socket.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import shutil
import socket
import sys
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse
from typing import Any


DEFAULT_ENDPOINT = "ipc:///tmp/hermes-agent-bridge.sock"
DEFAULT_AGENT_ROOT = "~/.hermes/hermes-agent"
DEFAULT_HERMES_HOME = "~/.hermes"


def _bridge_platform() -> str:
    return os.environ.get("HERMES_AGENT_BRIDGE_PLATFORM", "cli").strip() or "cli"


def _candidate_agent_roots(raw: str | None = None) -> list[Path]:
    candidates: list[Path] = []
    if raw:
        candidates.append(Path(raw).expanduser())

    env_root = os.environ.get("HERMES_AGENT_ROOT")
    if env_root:
        candidates.append(Path(env_root).expanduser())

    hermes_bin = shutil.which(os.environ.get("HERMES_BIN", "hermes"))
    if hermes_bin:
        bin_path = Path(hermes_bin).resolve()
        candidates.extend([
            bin_path.parent.parent,
            bin_path.parent.parent.parent,
            bin_path.parent.parent / "hermes-agent",
        ])

    script_path = Path(__file__).resolve()
    candidates.extend([
        Path.cwd(),
        Path.cwd() / ".hermes" / "hermes-agent",
        Path.cwd() / "hermes-agent",
        script_path.parent,
        script_path.parent.parent,
        script_path.parent.parent.parent,
        script_path.parent.parent.parent / ".hermes" / "hermes-agent",
    ])
    for parent in script_path.parents:
        candidates.extend([
            parent / ".hermes" / "hermes-agent",
            parent / "hermes-agent",
        ])

    candidates.extend([
        Path.home() / ".hermes" / "hermes-agent",
        Path.home() / "hermes-agent",
        Path("/opt/hermes/hermes-agent"),
        Path("/opt/hermes-agent"),
        Path("/usr/local/hermes-agent"),
    ])
    candidates.append(Path(DEFAULT_AGENT_ROOT).expanduser())

    unique: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
        except OSError:
            resolved = candidate
        key = str(resolved)
        if key not in seen:
            seen.add(key)
            unique.append(resolved)
    return unique


def _discover_agent_root(raw: str | None = None) -> Path:
    for candidate in _candidate_agent_roots(raw):
        if (candidate / "run_agent.py").exists():
            return candidate
    attempted = ", ".join(str(path) for path in _candidate_agent_roots(raw))
    raise RuntimeError(
        "hermes-agent run_agent.py not found. Pass --agent-root or set "
        f"HERMES_AGENT_ROOT. Tried: {attempted}"
    )


def _discover_hermes_home(raw: str | None = None) -> Path:
    if raw:
        return Path(raw).expanduser().resolve()
    env_home = os.environ.get("HERMES_HOME")
    if env_home:
        return Path(env_home).expanduser().resolve()
    return Path(DEFAULT_HERMES_HOME).expanduser().resolve()


def _jsonable(value: Any) -> Any:
    try:
        json.dumps(value)
        return value
    except TypeError:
        if isinstance(value, dict):
            return {str(k): _jsonable(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [_jsonable(v) for v in value]
        return str(value)


def _agent_root() -> Path:
    return _discover_agent_root(os.environ.get("HERMES_AGENT_ROOT"))


def _hermes_home() -> Path:
    return _discover_hermes_home(os.environ.get("HERMES_HOME"))


def _set_path_env(agent_root: str | None = None, hermes_home: str | None = None) -> None:
    os.environ["HERMES_AGENT_ROOT"] = str(_discover_agent_root(agent_root))
    os.environ["HERMES_HOME"] = str(_discover_hermes_home(hermes_home))


def _ensure_agent_imports() -> None:
    root = _agent_root()
    if not (root / "run_agent.py").exists():
        raise RuntimeError(f"hermes-agent run_agent.py not found under {root}")
    root_s = str(root)
    if root_s not in sys.path:
        sys.path.insert(0, root_s)
    os.environ.setdefault("HERMES_HOME", str(_hermes_home()))


def _load_cfg() -> dict[str, Any]:
    _ensure_agent_imports()
    try:
        from hermes_cli.config import load_config

        cfg = load_config()
        return cfg if isinstance(cfg, dict) else {}
    except Exception:
        try:
            import yaml

            path = _hermes_home() / "config.yaml"
            if not path.exists():
                return {}
            return yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        except Exception:
            return {}


def _resolve_model(cfg: dict[str, Any]) -> str:
    env_model = (
        os.environ.get("HERMES_MODEL", "")
        or os.environ.get("HERMES_INFERENCE_MODEL", "")
    ).strip()
    if env_model:
        return env_model
    model_cfg = cfg.get("model", "")
    if isinstance(model_cfg, dict):
        return str(model_cfg.get("default") or "").strip()
    if isinstance(model_cfg, str):
        return model_cfg.strip()
    return ""


def _resolve_runtime(model: str, provider: str | None = None) -> dict[str, Any]:
    _ensure_agent_imports()
    from hermes_cli.runtime_provider import resolve_runtime_provider

    requested = provider or os.environ.get("HERMES_BRIDGE_PROVIDER", "").strip() or None
    return resolve_runtime_provider(requested=requested, target_model=model or None)


def _load_enabled_toolsets() -> list[str] | None:
    _ensure_agent_imports()
    raw = os.environ.get("HERMES_BRIDGE_TOOLSETS", "").strip()
    if raw:
        values = [part.strip() for part in raw.split(",") if part.strip()]
        if any(value in {"all", "*"} for value in values):
            return None
        return values or None

    try:
        from hermes_cli.config import load_config
        from hermes_cli.tools_config import _get_platform_tools

        cfg = load_config()
        enabled = sorted(_get_platform_tools(cfg, "cli", include_default_mcp_servers=True))
        return enabled or None
    except Exception:
        return None


def _load_reasoning_config() -> dict[str, Any] | None:
    _ensure_agent_imports()
    try:
        from hermes_constants import parse_reasoning_effort

        effort = str((_load_cfg().get("agent") or {}).get("reasoning_effort", "") or "").strip()
        return parse_reasoning_effort(effort)
    except Exception:
        return None


def _load_service_tier() -> str | None:
    raw = str((_load_cfg().get("agent") or {}).get("service_tier", "") or "").strip().lower()
    if raw in {"fast", "priority", "on"}:
        return "priority"
    return None


def _cfg_max_turns(cfg: dict[str, Any], default: int = 90) -> int:
    try:
        env_max = int(os.environ.get("HERMES_BRIDGE_MAX_TURNS", "") or 0)
        if env_max > 0:
            return env_max
    except ValueError:
        pass
    agent_cfg = cfg.get("agent") or {}
    try:
        return int(agent_cfg.get("max_turns") or cfg.get("max_turns") or default)
    except (TypeError, ValueError):
        return default


class SessionDbHolder:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._db = None
        self._error: str | None = None

    def get(self):
        with self._lock:
            if self._db is not None:
                return self._db
            _ensure_agent_imports()
            try:
                from hermes_state import SessionDB

                self._db = SessionDB()
                self._error = None
            except Exception as exc:
                self._error = str(exc)
                self._db = None
            return self._db

    @property
    def error(self) -> str | None:
        return self._error


@dataclass
class RunRecord:
    run_id: str
    session_id: str
    status: str = "running"
    started_at: float = field(default_factory=time.time)
    ended_at: float | None = None
    result: dict[str, Any] | None = None
    error: str | None = None
    deltas: list[str] = field(default_factory=list)
    events: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class AgentSession:
    session_id: str
    agent: Any
    history: list[dict[str, Any]] = field(default_factory=list)
    config: dict[str, Any] = field(default_factory=dict)
    running: bool = False
    current_run_id: str | None = None
    lock: threading.RLock = field(default_factory=threading.RLock)
    created_at: float = field(default_factory=time.time)
    last_used_at: float = field(default_factory=time.time)


class AgentPool:
    def __init__(self) -> None:
        self._sessions: dict[str, AgentSession] = {}
        self._runs: dict[str, RunRecord] = {}
        self._lock = threading.RLock()
        self._db = SessionDbHolder()

    def _load_history(self, session_id: str) -> tuple[str, list[dict[str, Any]], dict[str, Any] | None]:
        db = self._db.get()
        if db is None:
            return session_id, [], None

        resolved_session_id = session_id
        try:
            if hasattr(db, "resolve_resume_session_id"):
                resolved_session_id = db.resolve_resume_session_id(session_id)
        except Exception:
            resolved_session_id = session_id

        session_row = None
        try:
            if hasattr(db, "get_session"):
                session_row = db.get_session(resolved_session_id)
        except Exception:
            session_row = None

        history: list[dict[str, Any]] = []
        try:
            if hasattr(db, "get_messages_as_conversation"):
                history = db.get_messages_as_conversation(
                    resolved_session_id,
                    include_ancestors=True,
                )
        except Exception:
            history = []
        return resolved_session_id, _jsonable(history), _jsonable(session_row)

    def get_or_create(
        self,
        session_id: str,
    ) -> AgentSession:
        with self._lock:
            existing = self._sessions.get(session_id)
            if existing is not None:
                existing.last_used_at = time.time()
                return existing

            _ensure_agent_imports()
            from run_agent import AIAgent

            cfg = _load_cfg()
            resolved_model = _resolve_model(cfg)
            runtime = _resolve_runtime(resolved_model)
            agent_cfg = cfg.get("agent") or {}
            prompt = str(agent_cfg.get("system_prompt", "") or "").strip() or None
            resolved_session_id, history, session_row = self._load_history(session_id)

            agent = AIAgent(
                model=resolved_model,
                max_iterations=_cfg_max_turns(cfg, 90),
                provider=runtime.get("provider"),
                base_url=runtime.get("base_url"),
                api_key=runtime.get("api_key"),
                api_mode=runtime.get("api_mode"),
                acp_command=runtime.get("command"),
                acp_args=runtime.get("args"),
                credential_pool=runtime.get("credential_pool"),
                quiet_mode=True,
                verbose_logging=False,
                reasoning_config=_load_reasoning_config(),
                service_tier=_load_service_tier(),
                enabled_toolsets=_load_enabled_toolsets(),
                platform=_bridge_platform(),
                session_id=resolved_session_id,
                session_db=self._db.get(),
                ephemeral_system_prompt=prompt,
                status_callback=self._status_callback(session_id),
                thinking_callback=self._text_event_callback(session_id, "thinking.delta"),
                reasoning_callback=self._text_event_callback(session_id, "reasoning.delta"),
            )

            session = AgentSession(
                session_id=resolved_session_id,
                agent=agent,
                history=history,
                config={
                    "requested_session_id": session_id,
                    "resolved_session_id": resolved_session_id,
                    "model": resolved_model,
                    "resumed_model": session_row.get("model") if isinstance(session_row, dict) else None,
                    "provider": runtime.get("provider"),
                    "base_url": runtime.get("base_url"),
                    "api_mode": runtime.get("api_mode"),
                    "platform": _bridge_platform(),
                    "resumed": bool(history),
                    "resumed_message_count": len(history),
                    "db_error": self._db.error,
                },
            )
            self._sessions[session_id] = session
            if resolved_session_id != session_id:
                self._sessions[resolved_session_id] = session
            return session

    def _append_event(self, session_id: str, event: dict[str, Any]) -> None:
        with self._lock:
            session = self._sessions.get(session_id)
            run_id = session.current_run_id if session else None
            if run_id and run_id in self._runs:
                self._runs[run_id].events.append(_jsonable(event))

    def _status_callback(self, session_id: str):
        def callback(kind, text=None):
            self._append_event(session_id, {"event": "status", "kind": str(kind), "text": None if text is None else str(text)})

        return callback

    def _text_event_callback(self, session_id: str, event_name: str):
        def callback(text):
            self._append_event(session_id, {"event": event_name, "text": str(text)})

        return callback

    def start_chat(
        self,
        session_id: str,
        message: Any,
    ) -> RunRecord:
        session = self.get_or_create(session_id)
        with session.lock:
            if session.running:
                raise RuntimeError(f"session {session_id} is already running")
            run_id = uuid.uuid4().hex
            record = RunRecord(run_id=run_id, session_id=session_id)
            with self._lock:
                self._runs[run_id] = record
            session.running = True
            session.current_run_id = run_id
            session.last_used_at = time.time()

        thread = threading.Thread(
            target=self._run_chat,
            args=(session, record, message),
            daemon=True,
            name=f"hermes-bridge-run-{run_id[:8]}",
        )
        thread.start()
        return record

    def _run_chat(self, session: AgentSession, record: RunRecord, message: Any) -> None:
        def stream_callback(delta: str) -> None:
            with self._lock:
                record.deltas.append(str(delta))

        try:
            with session.lock:
                history = copy.deepcopy(session.history)
            result = session.agent.run_conversation(
                message,
                conversation_history=history,
                task_id=record.run_id,
                stream_callback=stream_callback,
            )
            result = _jsonable(result if isinstance(result, dict) else {"value": result})
            with session.lock:
                if isinstance(result.get("messages"), list):
                    session.history = result["messages"]
                record.status = "interrupted" if result.get("interrupted") else "complete"
                record.result = result
                record.ended_at = time.time()
                session.running = False
                session.current_run_id = None
                session.last_used_at = time.time()
        except Exception as exc:
            with session.lock:
                record.status = "error"
                record.error = str(exc)
                record.result = {"error": str(exc), "traceback": traceback.format_exc()}
                record.ended_at = time.time()
                session.running = False
                session.current_run_id = None
                session.last_used_at = time.time()

    def interrupt(self, session_id: str, message: str | None = None) -> dict[str, Any]:
        with self._lock:
            session = self._sessions.get(session_id)
        if session is None:
            raise KeyError(f"unknown session: {session_id}")
        if not hasattr(session.agent, "interrupt"):
            raise RuntimeError("agent does not support interrupt")
        session.agent.interrupt(message)
        return {"status": "interrupted", "session_id": session_id}

    def steer(self, session_id: str, text: str) -> dict[str, Any]:
        with self._lock:
            session = self._sessions.get(session_id)
        if session is None:
            raise KeyError(f"unknown session: {session_id}")
        if not hasattr(session.agent, "steer"):
            raise RuntimeError("agent does not support steer")
        accepted = bool(session.agent.steer(text))
        return {"status": "queued" if accepted else "rejected", "accepted": accepted, "text": text}

    def get_history(self, session_id: str) -> dict[str, Any]:
        with self._lock:
            session = self._sessions.get(session_id)
        if session is None:
            raise KeyError(f"unknown session: {session_id}")
        with session.lock:
            return {"session_id": session_id, "history": copy.deepcopy(session.history)}

    def get_result(self, run_id: str) -> dict[str, Any]:
        with self._lock:
            record = self._runs.get(run_id)
        if record is None:
            raise KeyError(f"unknown run: {run_id}")
        return {
            "run_id": record.run_id,
            "session_id": record.session_id,
            "status": record.status,
            "started_at": record.started_at,
            "ended_at": record.ended_at,
            "output": "".join(record.deltas),
            "deltas": list(record.deltas),
            "events": list(record.events),
            "result": record.result,
            "error": record.error,
        }

    def get_output(self, run_id: str, cursor: int = 0) -> dict[str, Any]:
        with self._lock:
            record = self._runs.get(run_id)
        if record is None:
            raise KeyError(f"unknown run: {run_id}")
        cursor = max(0, int(cursor or 0))
        deltas = list(record.deltas)
        next_cursor = len(deltas)
        return {
            "run_id": record.run_id,
            "session_id": record.session_id,
            "status": record.status,
            "delta": "".join(deltas[cursor:]),
            "cursor": next_cursor,
            "output": "".join(deltas),
            "done": record.status != "running",
            "result": record.result if record.status != "running" else None,
            "error": record.error,
        }

    def destroy(self, session_id: str) -> dict[str, Any]:
        with self._lock:
            session = self._sessions.pop(session_id, None)
        if session is None:
            return {"session_id": session_id, "destroyed": False}
        if session.running and hasattr(session.agent, "interrupt"):
            try:
                session.agent.interrupt("Session destroyed")
            except Exception:
                pass
        return {"session_id": session_id, "destroyed": True}

    def reset(self, session_id: str, title: str | None = None) -> dict[str, Any]:
        with self._lock:
            session = self._sessions.get(session_id)
        if session is not None and session.running:
            raise RuntimeError(f"session {session_id} is running")

        self.destroy(session_id)
        new_session_id = uuid.uuid4().hex
        session = self.get_or_create(new_session_id)
        if title and self._db.get() is not None:
            try:
                self._db.get().set_session_title(new_session_id, title)
            except Exception:
                pass
        return {
            "session_id": session_id,
            "new_session_id": new_session_id,
            "status": "reset",
            "message": f"Started new CLI session {new_session_id}",
            "config": session.config,
        }

    def clear(self, session_id: str) -> dict[str, Any]:
        return self.reset(session_id)

    def save(self, session_id: str) -> dict[str, Any]:
        session = self._sessions.get(session_id)
        if session is None:
            raise KeyError(f"unknown session: {session_id}")
        with session.lock:
            history = copy.deepcopy(session.history)
            config = copy.deepcopy(session.config)
        if not history:
            return {"session_id": session_id, "saved": False, "message": "No conversation to save."}
        saved_dir = _hermes_home() / "sessions" / "saved"
        saved_dir.mkdir(parents=True, exist_ok=True)
        path = saved_dir / f"hermes_conversation_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        path.write_text(json.dumps({
            "session_id": session_id,
            "model": config.get("model"),
            "messages": history,
        }, indent=2, ensure_ascii=False), encoding="utf-8")
        return {"session_id": session_id, "saved": True, "path": str(path), "message": f"Conversation snapshot saved to: {path}"}

    def _last_user_index(self, history: list[dict[str, Any]]) -> int | None:
        for idx in range(len(history) - 1, -1, -1):
            if history[idx].get("role") == "user":
                return idx
        return None

    def undo(self, session_id: str) -> dict[str, Any]:
        session = self._sessions.get(session_id)
        if session is None:
            raise KeyError(f"unknown session: {session_id}")
        with session.lock:
            idx = self._last_user_index(session.history)
            if idx is None:
                return {"session_id": session_id, "undone": False, "message": "No user message found to undo.", "history": copy.deepcopy(session.history)}
            removed = len(session.history) - idx
            session.history = session.history[:idx]
            history = copy.deepcopy(session.history)
        return {"session_id": session_id, "undone": True, "removed": removed, "message": f"Undid {removed} message(s).", "history": history}

    def retry(self, session_id: str) -> dict[str, Any]:
        session = self._sessions.get(session_id)
        if session is None:
            raise KeyError(f"unknown session: {session_id}")
        with session.lock:
            idx = self._last_user_index(session.history)
            if idx is None:
                return {"session_id": session_id, "retry": False, "message": "No user message found to retry.", "history": copy.deepcopy(session.history)}
            retry_input = copy.deepcopy(session.history[idx].get("content", ""))
            session.history = session.history[:idx]
            history = copy.deepcopy(session.history)
        return {"session_id": session_id, "retry": True, "retry_input": retry_input, "message": "Retrying last user message.", "history": history}

    def title(self, session_id: str, title: str) -> dict[str, Any]:
        cleaned = title.strip()
        if not cleaned:
            return {"session_id": session_id, "updated": False, "message": "Usage: /title <your session title>"}
        db = self._db.get()
        if db is not None:
            try:
                if hasattr(db, "set_session_title"):
                    db.set_session_title(session_id, cleaned)
            except Exception:
                pass
        return {"session_id": session_id, "updated": True, "title": cleaned, "message": f"Session title set: {cleaned}"}

    def branch(self, session_id: str, title: str | None = None) -> dict[str, Any]:
        session = self._sessions.get(session_id)
        if session is None:
            raise KeyError(f"unknown session: {session_id}")
        with session.lock:
            if session.running:
                raise RuntimeError(f"session {session_id} is running")
            history = copy.deepcopy(session.history)
            config = copy.deepcopy(session.config)
        if not history:
            return {"session_id": session_id, "branched": False, "message": "No conversation to branch."}

        new_session_id = uuid.uuid4().hex
        db = self._db.get()
        if db is not None:
            try:
                db.end_session(session_id, "branched")
            except Exception:
                pass
            try:
                db.create_session(
                    session_id=new_session_id,
                    source=_bridge_platform(),
                    model=config.get("model"),
                    model_config={"max_iterations": config.get("max_turns")},
                    parent_session_id=session_id,
                )
                for msg in history:
                    db.append_message(
                        session_id=new_session_id,
                        role=msg.get("role", "user"),
                        content=msg.get("content"),
                        tool_name=msg.get("tool_name") or msg.get("name"),
                        tool_calls=msg.get("tool_calls"),
                        tool_call_id=msg.get("tool_call_id"),
                        reasoning=msg.get("reasoning"),
                    )
                if title:
                    db.set_session_title(new_session_id, title)
            except Exception:
                pass

        new_session = self.get_or_create(new_session_id)
        with new_session.lock:
            new_session.history = history
        return {
            "session_id": session_id,
            "new_session_id": new_session_id,
            "branched": True,
            "history": history,
            "message": f"Branched session {new_session_id}",
        }

    def compress(self, session_id: str, focus: str | None = None) -> dict[str, Any]:
        session = self._sessions.get(session_id)
        if session is None:
            raise KeyError(f"unknown session: {session_id}")
        with session.lock:
            if session.running:
                raise RuntimeError(f"session {session_id} is running")
            history = copy.deepcopy(session.history)
        if len(history) < 4:
            return {"session_id": session_id, "compressed": False, "message": "Not enough conversation to compress (need at least 4 messages).", "history": history}
        if not getattr(session.agent, "compression_enabled", False):
            return {"session_id": session_id, "compressed": False, "message": "Compression is disabled in config.", "history": history}
        if not hasattr(session.agent, "_compress_context"):
            return {"session_id": session_id, "compressed": False, "message": "Agent does not expose manual compression.", "history": history}
        compressed, _ = session.agent._compress_context(history, None, focus_topic=focus or None)
        compressed = _jsonable(compressed)
        with session.lock:
            session.history = compressed
        return {
            "session_id": session_id,
            "compressed": True,
            "before": len(history),
            "after": len(compressed),
            "history": copy.deepcopy(compressed),
            "message": f"Compressed {len(history)} messages to {len(compressed)} messages.",
        }

    def history_summary(self, session_id: str) -> dict[str, Any]:
        result = self.get_history(session_id)
        history = result.get("history") or []
        lines = []
        visible = 0
        hidden_tools = 0
        for msg in history:
            role = msg.get("role", "unknown")
            if role == "tool":
                hidden_tools += 1
                continue
            if role not in {"user", "assistant"}:
                continue
            visible += 1
            label = "You" if role == "user" else "Hermes"
            content = str(msg.get("content") or "")
            preview = content[:400] + ("..." if len(content) > 400 else "")
            lines.append(f"[{label} #{visible}] {preview or '(no text response)'}")
        if hidden_tools:
            lines.append(f"[Tools] ({hidden_tools} tool message(s) hidden)")
        return {"session_id": session_id, "history": history, "message": "\n\n".join(lines) if lines else "No conversation history yet."}

    def status(self, session_id: str) -> dict[str, Any]:
        with self._lock:
            session = self._sessions.get(session_id)
        if session is None:
            return {
                "session_id": session_id,
                "exists": False,
                "running": False,
                "message_count": 0,
            }
        with session.lock:
            return {
                "session_id": session_id,
                "exists": True,
                "running": session.running,
                "current_run_id": session.current_run_id,
                "created_at": session.created_at,
                "last_used_at": session.last_used_at,
                "message_count": len(session.history),
                "config": session.config,
            }

    def command(self, session_id: str, command: str) -> dict[str, Any]:
        raw = str(command or "").strip()
        if not raw:
            raise ValueError("command is required")
        if not raw.startswith("/"):
            raw = f"/{raw}"

        name, _, rest = raw[1:].partition(" ")
        name = name.strip().lower()
        args = rest.strip()

        if name in {"new", "reset"}:
            return {
                "command": raw,
                "handled": True,
                **self.reset(session_id, args or None),
            }
        if name == "clear":
            return {"command": raw, "handled": True, **self.clear(session_id)}
        if name == "redraw":
            return {"command": raw, "handled": True, "message": "UI redraw requested."}
        if name == "history":
            return {"command": raw, "handled": True, **self.history_summary(session_id)}
        if name == "save":
            return {"command": raw, "handled": True, **self.save(session_id)}
        if name == "retry":
            return {"command": raw, "handled": True, **self.retry(session_id)}
        if name == "undo":
            return {"command": raw, "handled": True, **self.undo(session_id)}
        if name == "title":
            return {"command": raw, "handled": True, **self.title(session_id, args)}
        if name in {"branch", "fork"}:
            return {"command": raw, "handled": True, **self.branch(session_id, args or None)}
        if name == "compress":
            return {"command": raw, "handled": True, **self.compress(session_id, args or None)}
        if name == "stop":
            try:
                result = self.interrupt(session_id, "Stopped by slash command")
            except KeyError:
                result = {"session_id": session_id, "status": "idle"}
            return {"command": raw, "handled": True, "message": "Stop requested", **result}
        if name == "steer":
            if not args:
                return {"command": raw, "handled": True, "accepted": False, "message": "Usage: /steer <prompt>"}
            return {"command": raw, "handled": True, **self.steer(session_id, args)}
        if name == "status":
            return {"command": raw, "handled": True, **self.status(session_id)}
        if name in {"help", "?"}:
            return {
                "command": raw,
                "handled": True,
                "message": "Supported bridge commands: /new, /reset, /stop, /steer <prompt>, /status, /help",
            }

        return {
            "command": raw,
            "handled": False,
            "message": f"Slash command {raw.split()[0]} is not implemented in the Web UI CLI bridge yet.",
        }

    def list_sessions(self) -> dict[str, Any]:
        with self._lock:
            sessions = list(self._sessions.values())
        return {
            "sessions": [
                {
                    "session_id": s.session_id,
                    "running": s.running,
                    "current_run_id": s.current_run_id,
                    "created_at": s.created_at,
                    "last_used_at": s.last_used_at,
                    "message_count": len(s.history),
                    "config": s.config,
                }
                for s in sessions
            ]
        }


class BridgeServer:
    def __init__(self, endpoint: str) -> None:
        self.endpoint = endpoint
        self.pool = AgentPool()
        self._stop = threading.Event()

    def handle(self, req: dict[str, Any]) -> dict[str, Any]:
        action = str(req.get("action") or "").strip()
        if not action:
            raise ValueError("action is required")

        if action == "ping":
            return {"pong": True, "time": time.time(), "agent_root": str(_agent_root())}

        if action == "chat":
            session_id = str(req.get("session_id") or "").strip() or uuid.uuid4().hex
            message = req.get("message", req.get("input", ""))
            record = self.pool.start_chat(session_id, message)
            if req.get("wait"):
                timeout = float(req.get("timeout", 0) or 0)
                deadline = time.time() + timeout if timeout > 0 else None
                while record.status == "running":
                    if deadline is not None and time.time() >= deadline:
                        break
                    time.sleep(0.05)
                return self.pool.get_result(record.run_id)
            return {"run_id": record.run_id, "session_id": session_id, "status": record.status}

        if action == "command":
            session_id = str(req.get("session_id") or "").strip()
            if not session_id:
                raise ValueError("session_id is required")
            return self.pool.command(session_id, str(req.get("command") or req.get("text") or ""))

        if action == "get_result":
            return self.pool.get_result(str(req.get("run_id") or ""))

        if action == "get_output":
            return self.pool.get_output(
                str(req.get("run_id") or ""),
                int(req.get("cursor") or 0),
            )

        if action == "interrupt":
            return self.pool.interrupt(str(req.get("session_id") or ""), req.get("message"))

        if action == "steer":
            text = str(req.get("text") or req.get("message") or "").strip()
            if not text:
                raise ValueError("text is required")
            return self.pool.steer(str(req.get("session_id") or ""), text)

        if action == "get_history":
            return self.pool.get_history(str(req.get("session_id") or ""))

        if action == "destroy":
            return self.pool.destroy(str(req.get("session_id") or ""))

        if action == "list":
            return self.pool.list_sessions()

        if action == "shutdown":
            self._stop.set()
            return {"status": "shutting_down"}

        raise ValueError(f"unknown action: {action}")

    def _make_server_socket(self) -> socket.socket:
        if self.endpoint.startswith("ipc://"):
            if not hasattr(socket, "AF_UNIX"):
                raise RuntimeError("ipc:// endpoints require Unix domain socket support; use tcp://host:port on this platform")
            sock_path = Path(self.endpoint.removeprefix("ipc://"))
            sock_path.parent.mkdir(parents=True, exist_ok=True)
            try:
                sock_path.unlink(missing_ok=True)
            except OSError:
                pass
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(str(sock_path))
            return server

        parsed = urlparse(self.endpoint)
        if parsed.scheme != "tcp":
            raise RuntimeError(f"unsupported endpoint scheme: {self.endpoint}")
        host = parsed.hostname or "127.0.0.1"
        port = int(parsed.port or 0)
        if port <= 0:
            raise RuntimeError(f"tcp endpoint requires a port: {self.endpoint}")
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind((host, port))
        return server

    def _read_request(self, conn: socket.socket) -> dict[str, Any]:
        chunks: list[bytes] = []
        while True:
            chunk = conn.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
            if b"\n" in chunk:
                break
        if not chunks:
            raise RuntimeError("empty request")
        line = b"".join(chunks).split(b"\n", 1)[0].strip()
        if not line:
            raise RuntimeError("empty request")
        return json.loads(line.decode("utf-8"))

    def _write_response(self, conn: socket.socket, resp: dict[str, Any]) -> None:
        payload = json.dumps(resp, ensure_ascii=False, default=str) + "\n"
        conn.sendall(payload.encode("utf-8"))

    def serve_forever(self) -> None:
        server = self._make_server_socket()
        server.listen(16)
        server.settimeout(0.2)
        print(json.dumps({"event": "ready", "endpoint": self.endpoint}), flush=True)

        while not self._stop.is_set():
            conn: socket.socket | None = None
            try:
                try:
                    conn, _addr = server.accept()
                except socket.timeout:
                    continue
                try:
                    req = self._read_request(conn)
                    data = self.handle(req)
                    resp = {"ok": True, **_jsonable(data)}
                except Exception as exc:
                    resp = {
                        "ok": False,
                        "error": str(exc),
                        "error_type": exc.__class__.__name__,
                    }
                self._write_response(conn, resp)
            except KeyboardInterrupt:
                break
            except Exception as exc:
                print(f"[hermes-bridge] server loop error: {exc}", file=sys.stderr, flush=True)
            finally:
                if conn is not None:
                    try:
                        conn.close()
                    except OSError:
                        pass

        server.close()
        if self.endpoint.startswith("ipc://"):
            try:
                Path(self.endpoint.removeprefix("ipc://")).unlink(missing_ok=True)
            except OSError:
                pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Hermes AIAgent in-process bridge")
    parser.add_argument("--endpoint", default=os.environ.get("HERMES_AGENT_BRIDGE_ENDPOINT", DEFAULT_ENDPOINT))
    parser.add_argument("--agent-root", default=os.environ.get("HERMES_AGENT_ROOT", DEFAULT_AGENT_ROOT))
    parser.add_argument("--hermes-home", default=os.environ.get("HERMES_HOME", DEFAULT_HERMES_HOME))
    args = parser.parse_args(argv)

    _set_path_env(args.agent_root, args.hermes_home)
    _ensure_agent_imports()
    BridgeServer(args.endpoint).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
