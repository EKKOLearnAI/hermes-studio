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
import queue
import shutil
import socket
import sys
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse
from typing import Any


DEFAULT_ENDPOINT = "tcp://127.0.0.1:18765" if os.name == "nt" else "ipc:///tmp/hermes-agent-bridge.sock"
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


def _base_hermes_home() -> Path:
    return _discover_hermes_home(os.environ.get("HERMES_AGENT_BRIDGE_BASE_HOME") or DEFAULT_HERMES_HOME)


def _profile_home(profile: str | None) -> Path:
    base = _base_hermes_home()
    if not profile or profile == "default":
        return base
    profile_home = base / "profiles" / profile
    return profile_home if profile_home.exists() else base


def _set_path_env(agent_root: str | None = None, hermes_home: str | None = None) -> None:
    os.environ["HERMES_AGENT_ROOT"] = str(_discover_agent_root(agent_root))
    resolved_home = str(_discover_hermes_home(hermes_home))
    os.environ["HERMES_HOME"] = resolved_home
    os.environ["HERMES_AGENT_BRIDGE_BASE_HOME"] = resolved_home


def _ensure_agent_imports() -> None:
    root = _agent_root()
    if not (root / "run_agent.py").exists():
        raise RuntimeError(f"hermes-agent run_agent.py not found under {root}")
    root_s = str(root)
    if root_s not in sys.path:
        sys.path.insert(0, root_s)
    os.environ.setdefault("HERMES_HOME", str(_hermes_home()))
    os.environ.setdefault("HERMES_AGENT_BRIDGE_BASE_HOME", str(_hermes_home()))


def _load_cfg(profile: str | None = None) -> dict[str, Any]:
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


def _apply_profile_env(profile: str | None) -> str | None:
    """Temporarily set HERMES_HOME to the profile directory.
    Returns the original HERMES_HOME value to restore later.
    """
    if not profile or profile == "default":
        return os.environ.get("HERMES_HOME")
    profile_home = _profile_home(profile)
    if not (profile_home / "config.yaml").exists():
        return os.environ.get("HERMES_HOME")
    original = os.environ.get("HERMES_HOME")
    os.environ["HERMES_HOME"] = str(profile_home)
    return original


def _restore_profile_env(original: str | None) -> None:
    """Restore HERMES_HOME after profile-scoped agent creation."""
    if original is not None:
        os.environ["HERMES_HOME"] = original
    else:
        os.environ.pop("HERMES_HOME", None)


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
        from toolsets import resolve_toolset

        cfg = load_config()
        platform = _bridge_platform()
        enabled = sorted(_get_platform_tools(cfg, platform, include_default_mcp_servers=True))
        if platform != "cli":
            resolved_tools: set[str] = set()
            for toolset_name in enabled:
                try:
                    resolved_tools.update(resolve_toolset(toolset_name))
                except Exception:
                    pass
            if not resolved_tools:
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
        self._db_by_path: dict[str, Any] = {}
        self._error: str | None = None

    def get(self, db_path: Path | None = None):
        with self._lock:
            key = str((db_path or (_base_hermes_home() / "state.db")).resolve())
            if key in self._db_by_path:
                return self._db_by_path[key]
            _ensure_agent_imports()
            try:
                from hermes_state import SessionDB

                db = SessionDB(db_path=Path(key))
                self._db_by_path[key] = db
                self._error = None
                return db
            except Exception as exc:
                self._error = str(exc)
                return None

    @property
    def error(self) -> str | None:
        return self._error

    def get_for_profile(self, profile: str | None) -> Any:
        """Get a SessionDB for the given profile using an explicit DB path."""
        return self.get(_profile_home(profile) / "state.db")


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
        self._run_lock = threading.Lock()
        self._db = SessionDbHolder()
        self._approval_requests: dict[str, queue.Queue[str]] = {}
        self._gateway_approval_requests: dict[str, str] = {}
        self._compression_requests: dict[str, queue.Queue[dict[str, Any]]] = {}

    def get_or_create(
        self,
        session_id: str,
        profile: str | None = None,
    ) -> AgentSession:
        with self._lock:
            existing = self._sessions.get(session_id)
            if existing is not None:
                # If profile changed, destroy old session and recreate
                if profile and existing.config.get("profile") != profile:
                    if not existing.running:
                        self._destroy_session(session_id)
                    else:
                        existing.last_used_at = time.time()
                        return existing
                else:
                    existing.last_used_at = time.time()
                    return existing

            _ensure_agent_imports()
            from run_agent import AIAgent

            original_home = _apply_profile_env(profile)
            try:
                cfg = _load_cfg()
                resolved_model = _resolve_model(cfg)
                runtime = _resolve_runtime(resolved_model)
                agent_cfg = cfg.get("agent") or {}
                prompt = str(agent_cfg.get("system_prompt", "") or "").strip() or None

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
                    session_id=session_id,
                    session_db=self._db.get_for_profile(profile),
                    ephemeral_system_prompt=prompt,
                    status_callback=self._status_callback(session_id),
                    thinking_callback=self._text_event_callback(session_id, "thinking.delta"),
                    reasoning_callback=self._text_event_callback(session_id, "reasoning.delta"),
                    tool_progress_callback=self._tool_progress_callback(session_id),
                    tool_start_callback=self._tool_start_callback(session_id),
                    tool_complete_callback=self._tool_complete_callback(session_id),
                )
                agent.compression_enabled = False
                self._install_compression_hook(agent, session_id)

                session = AgentSession(
                    session_id=session_id,
                    agent=agent,
                    history=[],
                    config={
                        "requested_session_id": session_id,
                        "profile": profile or "default",
                        "model": resolved_model,
                        "provider": runtime.get("provider"),
                        "base_url": runtime.get("base_url"),
                        "api_mode": runtime.get("api_mode"),
                        "platform": _bridge_platform(),
                        "resumed": False,
                        "resumed_message_count": 0,
                        "db_error": self._db.error,
                    },
                )
                self._sessions[session_id] = session
                return session
            finally:
                _restore_profile_env(original_home)

    def _install_compression_hook(self, agent: Any, session_id: str) -> None:
        original = getattr(agent, "_compress_context", None)
        if not callable(original):
            return

        def wrapped_compress_context(messages, system_message, **kwargs):
            before_count = len(messages) if isinstance(messages, list) else 0
            request_id = uuid.uuid4().hex
            response_queue: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=1)
            with self._lock:
                self._compression_requests[request_id] = response_queue
            self._append_event(session_id, {
                "event": "bridge.compression.requested",
                "request_id": request_id,
                "message_count": before_count,
                "approx_tokens": kwargs.get("approx_tokens"),
                "focus_topic": kwargs.get("focus_topic"),
                "messages": _jsonable(messages),
            })
            try:
                response = response_queue.get(timeout=180)
                if response.get("error"):
                    raise RuntimeError(str(response.get("error")))
                compressed_messages = response.get("messages")
                if not isinstance(compressed_messages, list):
                    raise RuntimeError("bridge compression response missing messages")
                next_system_message = response.get("system_message", system_message)
                self._append_event(session_id, {
                    "event": "bridge.compression.completed",
                    "request_id": request_id,
                    "message_count": before_count,
                    "result_messages": len(compressed_messages),
                    "approx_tokens": kwargs.get("approx_tokens"),
                    "compressed": True,
                })
                return compressed_messages, next_system_message
            except queue.Empty:
                self._append_event(session_id, {
                    "event": "bridge.compression.failed",
                    "request_id": request_id,
                    "message_count": before_count,
                    "approx_tokens": kwargs.get("approx_tokens"),
                    "error": "bridge compression timed out",
                })
                raise RuntimeError("bridge compression timed out")
            except Exception as exc:
                self._append_event(session_id, {
                    "event": "bridge.compression.failed",
                    "request_id": request_id,
                    "message_count": before_count,
                    "approx_tokens": kwargs.get("approx_tokens"),
                    "error": str(exc),
                })
                raise
            finally:
                with self._lock:
                    self._compression_requests.pop(request_id, None)

        agent._compress_context = wrapped_compress_context

    def respond_compression(
        self,
        request_id: str,
        messages: list[dict[str, Any]] | None = None,
        system_message: str | None = None,
        error: str | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            response_queue = self._compression_requests.get(request_id)
        if response_queue is None:
            raise RuntimeError(f"compression request {request_id} not found")
        response_queue.put({
            "messages": messages,
            "system_message": system_message,
            "error": error,
        })
        return {"request_id": request_id, "handled": True}

    def _destroy_session(self, session_id: str) -> None:
        session = self._sessions.pop(session_id, None)
        if session is None:
            return
        with self._lock:
            for rid in list(self._runs):
                if self._runs[rid].session_id == session_id:
                    del self._runs[rid]

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

    def _tool_start_callback(self, session_id: str):
        def callback(tool_call_id, function_name, function_args):
            self._append_event(session_id, {
                "event": "tool.started",
                "tool_call_id": str(tool_call_id) if tool_call_id else "",
                "tool_name": str(function_name) if function_name else "",
                "args": _jsonable(function_args) if function_args else {},
            })

        return callback

    def _tool_complete_callback(self, session_id: str):
        def callback(tool_call_id, function_name, function_args, function_result=None):
            result_text = "" if function_result is None else str(function_result)
            print(
                "[hermes_bridge] tool_complete_callback "
                f"session={session_id} tool={function_name} "
                f"tool_call_id={tool_call_id} result_none={function_result is None} "
                f"result_len={len(result_text)}",
                file=sys.stderr,
                flush=True,
            )
            self._append_event(session_id, {
                "event": "tool.completed",
                "tool_call_id": str(tool_call_id) if tool_call_id else "",
                "tool_name": str(function_name) if function_name else "",
                "args": _jsonable(function_args) if function_args else {},
                "result": _jsonable(function_result) if function_result is not None else None,
                "result_preview": str(function_result)[:500] if function_result else None,
            })

        return callback

    def _tool_progress_callback(self, session_id: str):
        def callback(event_type, function_name=None, preview=None, function_args=None, **kwargs):
            if event_type in (None, "tool.started", "tool.completed"):
                print(
                    "[hermes_bridge] tool_progress_callback "
                    f"session={session_id} event={event_type} tool={function_name} "
                    f"kwargs_keys={sorted(kwargs.keys())} "
                    f"preview_len={len(str(preview)) if preview is not None else 0}",
                    file=sys.stderr,
                    flush=True,
                )
            if event_type == "reasoning.available":
                self._append_event(session_id, {
                    "event": "reasoning.available",
                    "text": str(preview) if preview else "",
                })
                return

            if event_type == "_thinking":
                text = function_name
                if text:
                    self._append_event(session_id, {
                        "event": "reasoning.delta",
                        "text": str(text),
                    })
                return

            if event_type in (None, "tool.started"):
                # AIAgent also calls tool_start_callback with the real tool_call_id.
                # Use that event as canonical so resume/replay can match results.
                return

            if event_type == "tool.completed":
                # AIAgent sends the full function_result to tool_complete_callback.
                return

        return callback

    def _step_callback(self, session_id: str):
        def callback(step_info=None):
            self._append_event(session_id, {
                "event": "step",
                "step_info": _jsonable(step_info) if step_info else None,
            })

        return callback

    def _stream_delta_callback(self, session_id: str):
        def callback(delta=None):
            if delta is None:
                # Turn boundary signal (tools about to execute)
                self._append_event(session_id, {
                    "event": "turn.boundary",
                })
                return
            if delta:
                self._append_event(session_id, {
                    "event": "stream.delta",
                    "delta": str(delta),
                })

        return callback

    def _approval_callback(self, session_id: str):
        def callback(command: str, description: str, *, allow_permanent: bool = True) -> str:
            approval_id = uuid.uuid4().hex
            response_queue: queue.Queue[str] = queue.Queue(maxsize=1)
            with self._lock:
                self._approval_requests[approval_id] = response_queue
            choices = ["once", "session", "always", "deny"] if allow_permanent else ["once", "session", "deny"]
            self._append_event(session_id, {
                "event": "approval.requested",
                "approval_id": approval_id,
                "command": str(command or ""),
                "description": str(description or ""),
                "choices": choices,
                "allow_permanent": bool(allow_permanent),
                "timeout_ms": 60_000,
            })
            try:
                choice = response_queue.get(timeout=60)
            except queue.Empty:
                choice = "deny"
            finally:
                with self._lock:
                    self._approval_requests.pop(approval_id, None)
            self._append_event(session_id, {
                "event": "approval.resolved",
                "approval_id": approval_id,
                "choice": choice,
            })
            return choice

        return callback

    def _gateway_approval_notify(self, session_id: str):
        def callback(approval_data: dict[str, Any]) -> None:
            approval_id = uuid.uuid4().hex
            choices = ["once", "session", "always", "deny"]
            with self._lock:
                self._gateway_approval_requests[approval_id] = session_id
            self._append_event(session_id, {
                "event": "approval.requested",
                "approval_id": approval_id,
                "command": str(approval_data.get("command") or ""),
                "description": str(approval_data.get("description") or ""),
                "choices": choices,
                "allow_permanent": True,
                "timeout_ms": 300_000,
            })

        return callback

    def _prepersist_user_message(
        self,
        session: AgentSession,
        message: Any,
        conversation_history: list[dict[str, Any]] | None,
        profile: str | None,
    ) -> bool:
        user_content = str(message) if not isinstance(message, dict) else str(message.get("content", message))
        if not user_content.strip():
            return False

        db = self._db.get_for_profile(profile)
        if db is None:
            return False

        history_len = len(conversation_history) if conversation_history else 0

        try:
            if hasattr(db, "create_session"):
                db.create_session(
                    session_id=session.session_id,
                    source=_bridge_platform(),
                    model=session.config.get("model"),
                )

            if hasattr(db, "get_messages"):
                messages = db.get_messages(session.session_id)
                if messages:
                    last = messages[-1]
                    if last.get("role") == "user" and last.get("content") == user_content:
                        self._align_prepersist_flush_cursor(session, history_len)
                        return False

            db.append_message(
                session_id=session.session_id,
                role="user",
                content=user_content,
            )

            # AIAgent will build messages as conversation_history + current user.
            # Since the current user was pre-persisted above, align the flush
            # cursor so the normal end-of-turn flush starts at assistant/tool
            # messages generated by this run.
            self._align_prepersist_flush_cursor(session, history_len)
            return True
        except Exception:
            return False

    def _align_prepersist_flush_cursor(self, session: AgentSession, history_len: int) -> None:
        try:
            session.agent._last_flushed_db_idx = history_len + 1
        except Exception:
            pass

    def _session_db_message_count(self, session_id: str, profile: str | None) -> int | None:
        db = self._db.get_for_profile(profile)
        if db is None or not hasattr(db, "get_messages"):
            return None
        try:
            return len(db.get_messages(session_id) or [])
        except Exception:
            return None

    def _sync_result_tail_to_session_db(
        self,
        session: AgentSession,
        result: dict[str, Any],
        conversation_history: list[dict[str, Any]] | None,
        profile: str | None,
        db_count_after_prepersist: int | None,
    ) -> None:
        db = self._db.get_for_profile(profile)
        if db is None or db_count_after_prepersist is None:
            return

        after_count = self._session_db_message_count(session.session_id, profile)
        if after_count is None or after_count > db_count_after_prepersist:
            return

        messages = result.get("messages")
        if not isinstance(messages, list):
            return

        history_len = len(conversation_history) if conversation_history else 0
        generated = [
            msg for msg in messages[history_len + 1:]
            if isinstance(msg, dict) and msg.get("role") in {"assistant", "tool"}
        ]
        if not generated:
            return

        appended = 0
        for msg in generated:
            try:
                db.append_message(
                    session_id=session.session_id,
                    role=str(msg.get("role") or "assistant"),
                    content=msg.get("content"),
                    tool_name=msg.get("tool_name"),
                    tool_calls=msg.get("tool_calls") if isinstance(msg.get("tool_calls"), list) else None,
                    tool_call_id=msg.get("tool_call_id"),
                    finish_reason=msg.get("finish_reason"),
                    reasoning=msg.get("reasoning") if msg.get("role") == "assistant" else None,
                    reasoning_content=msg.get("reasoning_content") if msg.get("role") == "assistant" else None,
                    reasoning_details=msg.get("reasoning_details") if msg.get("role") == "assistant" else None,
                    codex_reasoning_items=msg.get("codex_reasoning_items") if msg.get("role") == "assistant" else None,
                    codex_message_items=msg.get("codex_message_items") if msg.get("role") == "assistant" else None,
                )
                appended += 1
            except Exception:
                break

        if appended:
            print(
                "[hermes_bridge] synced missing result tail to session db "
                f"session={session.session_id} appended={appended}",
                file=sys.stderr,
                flush=True,
            )

    def start_chat(
        self,
        session_id: str,
        message: Any,
        instructions: str | None = None,
        conversation_history: list[dict[str, Any]] | None = None,
        profile: str | None = None,
        force_compress: bool = False,
    ) -> RunRecord:
        session = self.get_or_create(session_id, profile=profile)
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
            args=(session, record, message, instructions, conversation_history, profile, force_compress),
            daemon=True,
            name=f"hermes-bridge-run-{run_id[:8]}",
        )
        thread.start()
        return record

    def _run_chat(self, session: AgentSession, record: RunRecord, message: Any, instructions: str | None = None, conversation_history: list[dict[str, Any]] | None = None, profile: str | None = None, force_compress: bool = False) -> None:
        with self._run_lock:
            def stream_callback(delta: str) -> None:
                with self._lock:
                    record.deltas.append(str(delta))

            try:
                previous_approval_callback = None
                previous_exec_ask = os.environ.get("HERMES_EXEC_ASK")
                approval_session_token = None
                registered_gateway_approval_session = None
                try:
                    from tools.terminal_tool import _get_approval_callback, set_approval_callback
                    from tools.approval import register_gateway_notify, set_current_session_key

                    previous_approval_callback = _get_approval_callback()
                    set_approval_callback(self._approval_callback(session.session_id))
                    approval_session_token = set_current_session_key(session.session_id)
                    register_gateway_notify(session.session_id, self._gateway_approval_notify(session.session_id))
                    registered_gateway_approval_session = session.session_id
                    os.environ["HERMES_EXEC_ASK"] = "1"
                except Exception:
                    previous_approval_callback = None
                self._prepersist_user_message(session, message, conversation_history, profile)
                db_count_after_prepersist = self._session_db_message_count(session.session_id, profile)
                if force_compress:
                    compress = getattr(session.agent, "_compress_context", None)
                    if callable(compress):
                        compressed_history, compressed_system = compress(
                            conversation_history if isinstance(conversation_history, list) else [],
                            instructions,
                            approx_tokens=None,
                            focus_topic="debug_force_compress",
                        )
                        if isinstance(compressed_history, list):
                            conversation_history = compressed_history
                        if isinstance(compressed_system, str):
                            instructions = compressed_system
                kwargs: dict[str, Any] = dict(
                    task_id=session.session_id,
                    stream_callback=stream_callback,
                )
                if instructions:
                    kwargs["system_message"] = instructions
                if conversation_history is not None:
                    kwargs["conversation_history"] = conversation_history
                result = session.agent.run_conversation(
                    message,
                    **kwargs,
                )
                result = _jsonable(result if isinstance(result, dict) else {"value": result})
                self._sync_result_tail_to_session_db(
                    session,
                    result,
                    conversation_history,
                    profile,
                    db_count_after_prepersist,
                )
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
            finally:
                try:
                    from tools.terminal_tool import set_approval_callback

                    set_approval_callback(previous_approval_callback)
                except Exception:
                    pass
                if approval_session_token is not None:
                    try:
                        from tools.approval import reset_current_session_key, unregister_gateway_notify

                        if registered_gateway_approval_session is not None:
                            unregister_gateway_notify(registered_gateway_approval_session)
                        reset_current_session_key(approval_session_token)
                    except Exception:
                        pass
                if previous_exec_ask is None:
                    os.environ.pop("HERMES_EXEC_ASK", None)
                else:
                    os.environ["HERMES_EXEC_ASK"] = previous_exec_ask

    def interrupt(self, session_id: str, message: str | None = None) -> dict[str, Any]:
        with self._lock:
            session = self._sessions.get(session_id)
        if session is None:
            raise KeyError(f"unknown session: {session_id}")
        if not hasattr(session.agent, "interrupt"):
            raise RuntimeError("agent does not support interrupt")
        session.agent.interrupt(message)
        deadline = time.time() + 10.0
        synced = False
        while time.time() < deadline:
            with session.lock:
                if not session.running:
                    synced = True
                    break
            time.sleep(0.05)
        return {"status": "interrupted", "session_id": session_id, "synced": synced}

    def steer(self, session_id: str, text: str) -> dict[str, Any]:
        with self._lock:
            session = self._sessions.get(session_id)
        if session is None:
            raise KeyError(f"unknown session: {session_id}")
        if not hasattr(session.agent, "steer"):
            raise RuntimeError("agent does not support steer")
        accepted = bool(session.agent.steer(text))
        return {"status": "queued" if accepted else "rejected", "accepted": accepted, "text": text}

    def respond_approval(self, approval_id: str, choice: str) -> dict[str, Any]:
        cleaned = str(choice or "deny").strip().lower()
        if cleaned not in {"once", "session", "always", "deny"}:
            cleaned = "deny"
        with self._lock:
            response_queue = self._approval_requests.get(approval_id)
        if response_queue is None:
            with self._lock:
                gateway_session_id = self._gateway_approval_requests.pop(approval_id, None)
            if gateway_session_id is None:
                return {"approval_id": approval_id, "resolved": False, "choice": cleaned}
            try:
                from tools.approval import resolve_gateway_approval

                resolved = resolve_gateway_approval(gateway_session_id, cleaned) > 0
            except Exception:
                resolved = False
            self._append_event(gateway_session_id, {
                "event": "approval.resolved",
                "approval_id": approval_id,
                "choice": cleaned,
            })
            return {"approval_id": approval_id, "resolved": resolved, "choice": cleaned}
        try:
            response_queue.put_nowait(cleaned)
        except queue.Full:
            pass
        return {"approval_id": approval_id, "resolved": True, "choice": cleaned}

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

    def get_output(self, run_id: str, cursor: int = 0, event_cursor: int = 0) -> dict[str, Any]:
        with self._lock:
            record = self._runs.get(run_id)
        if record is None:
            raise KeyError(f"unknown run: {run_id}")
        cursor = max(0, int(cursor or 0))
        deltas = list(record.deltas)
        next_cursor = len(deltas)
        event_cursor = max(0, int(event_cursor or 0))
        events = list(record.events)
        new_events = _jsonable(events[event_cursor:])
        next_event_cursor = len(events)
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
            "events": new_events,
            "event_cursor": next_event_cursor,
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

    def destroy_all(self) -> dict[str, Any]:
        with self._lock:
            ids = list(self._sessions.keys())
        destroyed = []
        for sid in ids:
            result = self.destroy(sid)
            destroyed.append(result)
        return {"destroyed": len(destroyed)}

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
    IDLE_TIMEOUT_SECONDS = 30 * 60  # 30 minutes
    GC_INTERVAL_SECONDS = 60  # check every minute

    def __init__(self, endpoint: str) -> None:
        self.endpoint = endpoint
        self.pool = AgentPool()
        self._stop = threading.Event()
        self._last_gc = time.time()

    def handle(self, req: dict[str, Any]) -> dict[str, Any]:
        action = str(req.get("action") or "").strip()
        if not action:
            raise ValueError("action is required")

        if action == "ping":
            return {"pong": True, "time": time.time(), "agent_root": str(_agent_root())}

        if action == "chat":
            session_id = str(req.get("session_id") or "").strip() or uuid.uuid4().hex
            message = req.get("message", req.get("input", ""))
            instructions = req.get("instructions") or req.get("system_message")
            conversation_history = req.get("conversation_history")
            profile = req.get("profile")
            record = self.pool.start_chat(
                session_id,
                message,
                instructions,
                conversation_history,
                profile,
                bool(req.get("force_compress")),
            )
            if req.get("wait"):
                timeout = float(req.get("timeout", 0) or 0)
                deadline = time.time() + timeout if timeout > 0 else None
                while record.status == "running":
                    if deadline is not None and time.time() >= deadline:
                        break
                    time.sleep(0.05)
                return self.pool.get_result(record.run_id)
            return {"run_id": record.run_id, "session_id": session_id, "status": record.status}

        if action == "get_result":
            return self.pool.get_result(str(req.get("run_id") or ""))

        if action == "get_output":
            return self.pool.get_output(
                str(req.get("run_id") or ""),
                int(req.get("cursor") or 0),
                int(req.get("event_cursor") or 0),
            )

        if action == "interrupt":
            return self.pool.interrupt(str(req.get("session_id") or ""), req.get("message"))

        if action == "steer":
            text = str(req.get("text") or req.get("message") or "").strip()
            if not text:
                raise ValueError("text is required")
            return self.pool.steer(str(req.get("session_id") or ""), text)

        if action == "approval_respond":
            approval_id = str(req.get("approval_id") or "").strip()
            if not approval_id:
                raise ValueError("approval_id is required")
            return self.pool.respond_approval(approval_id, str(req.get("choice") or "deny"))

        if action == "compression_respond":
            request_id = str(req.get("request_id") or "").strip()
            if not request_id:
                raise ValueError("request_id is required")
            messages = req.get("messages")
            if messages is not None and not isinstance(messages, list):
                raise ValueError("messages must be a list")
            return self.pool.respond_compression(
                request_id,
                messages=messages,
                system_message=req.get("system_message"),
                error=req.get("error"),
            )

        if action == "get_history":
            return self.pool.get_history(str(req.get("session_id") or ""))

        if action == "destroy":
            return self.pool.destroy(str(req.get("session_id") or ""))

        if action == "destroy_all":
            return self.pool.destroy_all()

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

    def _gc_idle_sessions(self) -> None:
        """Destroy sessions idle longer than IDLE_TIMEOUT_SECONDS."""
        now = time.time()
        if now - self._last_gc < self.GC_INTERVAL_SECONDS:
            return
        self._last_gc = now
        with self.pool._lock:
            idle_ids = [
                sid for sid, s in self.pool._sessions.items()
                if not s.running and now - s.last_used_at > self.IDLE_TIMEOUT_SECONDS
            ]
        for sid in idle_ids:
            self.pool.destroy(sid)

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
                    self._gc_idle_sessions()
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
