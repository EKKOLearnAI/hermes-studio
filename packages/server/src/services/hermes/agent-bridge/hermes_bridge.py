#!/usr/bin/env python3
"""Hermes in-process agent bridge.

This service intentionally lives outside the existing Web UI chat path. It
imports hermes-agent from HERMES_AGENT_ROOT (default: ~/.hermes/hermes-agent),
keeps AIAgent instances in memory by session_id, and exposes a small newline-
delimited JSON request/response protocol over a local socket.
"""

from __future__ import annotations

import argparse
import atexit
import copy
import errno
import hashlib
import importlib.util
import json
import locale
import os
import queue
import re
import signal
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse
from typing import Any, Callable


DEFAULT_ENDPOINT = "tcp://127.0.0.1:18765" if os.name == "nt" else "ipc:///tmp/hermes-agent-bridge.sock"
DEFAULT_AGENT_ROOT = "~/.hermes/hermes-agent"
DEFAULT_HERMES_HOME = "~/.hermes"
APPROVAL_TIMEOUT_SECONDS = 120
APPROVAL_TIMEOUT_MS = APPROVAL_TIMEOUT_SECONDS * 1000
PARENT_WATCHDOG_INTERVAL_SECONDS = 2.0
OPENROUTER_ATTRIBUTION_ENV = {
    "referer": "HERMES_OPENROUTER_APP_REFERER",
    "title": "HERMES_OPENROUTER_APP_TITLE",
    "categories": "HERMES_OPENROUTER_APP_CATEGORIES",
}
_SURROGATE_RE = re.compile("[\ud800-\udfff]")


def _bridge_platform() -> str:
    return os.environ.get("HERMES_AGENT_BRIDGE_PLATFORM", "cli").strip() or "cli"


def _positive_int(value: str | None) -> int | None:
    if not value:
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _process_exists(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        try:
            result = subprocess.run(
                ["tasklist.exe", "/FI", f"PID eq {pid}", "/NH"],
                check=False,
                capture_output=True,
                text=True,
                timeout=5,
            )
            return str(pid) in (result.stdout or "")
        except Exception:
            return True
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError as exc:
        return exc.errno != errno.ESRCH


def _start_parent_process_watchdog(
    parent_pid: int | None,
    stop_event: threading.Event,
    label: str,
    interval: float = PARENT_WATCHDOG_INTERVAL_SECONDS,
) -> None:
    if not parent_pid or parent_pid == os.getpid():
        return

    def run() -> None:
        while not stop_event.wait(interval):
            if _process_exists(parent_pid):
                continue
            print(
                f"[hermes-bridge] parent pid {parent_pid} exited; stopping {label}",
                file=sys.stderr,
                flush=True,
            )
            stop_event.set()
            return

    threading.Thread(target=run, daemon=True, name=f"hermes-bridge-parent-watchdog-{label}").start()


def _install_stop_signal_handlers(stop_event: threading.Event) -> Callable[[], None]:
    if threading.current_thread() is not threading.main_thread():
        return lambda: None

    previous: list[tuple[signal.Signals, Any]] = []

    def handle_signal(signum: int, _frame: Any) -> None:
        stop_event.set()

    for signum in (signal.SIGINT, signal.SIGTERM):
        try:
            sig = signal.Signals(signum)
            previous.append((sig, signal.getsignal(sig)))
            signal.signal(sig, handle_signal)
        except Exception:
            pass

    def restore() -> None:
        for sig, handler in previous:
            try:
                signal.signal(sig, handler)
            except Exception:
                pass

    return restore


def _suppress_bridge_platform_hint() -> None:
    raw = os.environ.get("HERMES_BRIDGE_SUPPRESS_PLATFORM_HINT", "cli").strip()
    if raw.lower() in {"0", "false", "no", "off"}:
        return
    targets = {part.strip().lower() for part in raw.split(",") if part.strip()}
    if not targets:
        return
    try:
        from agent import prompt_builder

        for target in targets:
            prompt_builder.PLATFORM_HINTS.pop(target, None)
    except Exception:
        pass

    run_agent_module = sys.modules.get("run_agent")
    hints = getattr(run_agent_module, "PLATFORM_HINTS", None)
    if isinstance(hints, dict):
        for target in targets:
            hints.pop(target, None)


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
        Path("/usr/local/lib/hermes-agent"),
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


def _find_agent_root(raw: str | None = None) -> Path | None:
    for candidate in _candidate_agent_roots(raw):
        if (candidate / "run_agent.py").exists():
            return candidate
    return None


def _discover_agent_root(raw: str | None = None) -> Path:
    root = _find_agent_root(raw)
    if root is not None:
        return root
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


def _normalize_base_home(home: Path) -> Path:
    if home.parent.name == "profiles":
        return home.parent.parent
    return home


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


def _sanitize_surrogates(value: Any) -> Any:
    if isinstance(value, str):
        return _SURROGATE_RE.sub("\ufffd", value)
    if isinstance(value, dict):
        return {_sanitize_surrogates(k): _sanitize_surrogates(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_sanitize_surrogates(v) for v in value]
    return value


def _json_default(value: Any) -> str:
    return _sanitize_surrogates(str(value))


def _json_line_bytes(value: Any) -> bytes:
    payload = json.dumps(_sanitize_surrogates(value), ensure_ascii=False, default=_json_default) + "\n"
    return payload.encode("utf-8")


def _bridge_log(event: str, payload: dict[str, Any]) -> None:
    try:
        body = {"event": event, **payload}
        print(
            "[hermes_bridge] " + json.dumps(_sanitize_surrogates(body), ensure_ascii=False, default=_json_default),
            file=sys.stderr,
            flush=True,
        )
    except Exception:
        print(f"[hermes_bridge] {event}", file=sys.stderr, flush=True)


def _tool_names_from_definitions(tools: Any) -> list[str]:
    if not isinstance(tools, list):
        return []
    names: list[str] = []
    for tool in tools:
        name = ""
        if isinstance(tool, dict):
            function = tool.get("function")
            if isinstance(function, dict):
                name = str(function.get("name") or "")
            if not name:
                name = str(tool.get("name") or "")
        else:
            name = str(getattr(tool, "name", "") or "")
        if name:
            names.append(name)
    return names


def _mcp_tool_names_from_names(tool_names: Any) -> list[str]:
    if not isinstance(tool_names, list):
        return []
    return sorted(str(name) for name in tool_names if str(name).startswith("mcp_"))


def _agent_root() -> Path | None:
    return _find_agent_root(os.environ.get("HERMES_AGENT_ROOT"))


def _hermes_home() -> Path:
    return _discover_hermes_home(os.environ.get("HERMES_HOME"))


def _base_hermes_home() -> Path:
    return _normalize_base_home(_discover_hermes_home(os.environ.get("HERMES_AGENT_BRIDGE_BASE_HOME") or DEFAULT_HERMES_HOME))


def _worker_profile() -> str | None:
    raw = os.environ.get("HERMES_AGENT_BRIDGE_WORKER_PROFILE", "").strip()
    return raw or None


def _profile_home(profile: str | None) -> Path:
    base = _base_hermes_home()
    if not profile or profile == "default":
        return base
    profile_home = base / "profiles" / profile
    return profile_home if profile_home.exists() else base


def _read_dotenv(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    values: dict[str, str] = {}
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            if stripped.startswith("export "):
                stripped = stripped[7:].strip()
            key, value = stripped.split("=", 1)
            key = key.strip()
            if not key or not (key[0].isalpha() or key[0] == "_"):
                continue
            if not all(ch.isalnum() or ch == "_" for ch in key):
                continue
            value = value.strip()
            if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
                value = value[1:-1]
            values[key] = value
        return values
    except Exception:
        return {}


def _profile_dotenv_keys() -> set[str]:
    base = _base_hermes_home()
    keys = set(_read_dotenv(base / ".env").keys())
    profiles_dir = base / "profiles"
    try:
        for entry in profiles_dir.iterdir():
            if entry.is_dir():
                keys.update(_read_dotenv(entry / ".env").keys())
    except Exception:
        pass
    return keys


def _set_path_env(agent_root: str | None = None, hermes_home: str | None = None) -> None:
    resolved_root = _discover_agent_root(agent_root) if agent_root else _find_agent_root()
    if resolved_root is not None:
        os.environ["HERMES_AGENT_ROOT"] = str(resolved_root)
    else:
        os.environ.pop("HERMES_AGENT_ROOT", None)
    resolved_home = _discover_hermes_home(hermes_home)
    os.environ["HERMES_HOME"] = str(resolved_home)
    os.environ["HERMES_AGENT_BRIDGE_BASE_HOME"] = str(_normalize_base_home(resolved_home))


def _ensure_agent_imports() -> None:
    root = _agent_root()
    if root is not None:
        root_s = str(root)
        if root_s not in sys.path:
            sys.path.insert(0, root_s)
    elif importlib.util.find_spec("run_agent") is None:
        raise RuntimeError(
            "hermes-agent run_agent.py not found in source locations and the "
            "current Python environment cannot import run_agent. Install "
            "hermes-agent or pass --agent-root/HERMES_AGENT_ROOT."
        )
    os.environ.setdefault("HERMES_HOME", str(_hermes_home()))
    os.environ.setdefault("HERMES_AGENT_BRIDGE_BASE_HOME", str(_hermes_home()))
    _apply_openrouter_attribution_override()


def _apply_openrouter_attribution_override() -> None:
    """Override hermes-agent OpenRouter attribution at bridge runtime only."""
    referer = os.environ.get(OPENROUTER_ATTRIBUTION_ENV["referer"], "").strip()
    title = os.environ.get(OPENROUTER_ATTRIBUTION_ENV["title"], "").strip()
    categories = os.environ.get(OPENROUTER_ATTRIBUTION_ENV["categories"], "").strip()
    if not (referer or title or categories):
        return
    try:
        from agent import auxiliary_client
    except Exception:
        return
    headers = dict(getattr(auxiliary_client, "_OR_HEADERS_BASE", {}) or {})
    if referer:
        headers["HTTP-Referer"] = referer
    if title:
        headers.pop("X-Title", None)
        headers["X-OpenRouter-Title"] = title
    if categories:
        headers["X-OpenRouter-Categories"] = categories
    try:
        auxiliary_client._OR_HEADERS_BASE = headers
    except Exception:
        pass


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


def _apply_profile_dotenv(profile: str | None) -> dict[str, str | None]:
    """Load only the active profile's .env into this bridge process.

    This mirrors Web UI gateway env isolation:
    - default keeps inherited env for compatibility, then overlays default .env
    - non-default clears keys seen in any profile .env, then overlays its .env
    The returned snapshot restores the bridge process after the agent call.
    """
    values = _read_dotenv(_profile_home(profile) / ".env")
    if profile and profile != "default":
        keys = _profile_dotenv_keys()
        keys.update(values.keys())
    else:
        keys = set(values.keys())
    snapshot = {key: os.environ.get(key) for key in keys}

    if profile and profile != "default":
        for key in keys:
            os.environ.pop(key, None)
    for key, value in values.items():
        os.environ[key] = value
    return snapshot


def _restore_profile_dotenv(snapshot: dict[str, str | None]) -> None:
    for key, value in snapshot.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


def _set_worker_profile_env(profile: str | None) -> None:
    profile_home = _profile_home(profile)
    os.environ["HERMES_HOME"] = str(profile_home)
    os.environ["HERMES_AGENT_BRIDGE_WORKER_PROFILE"] = profile or "default"
    _refresh_worker_profile_env()


def _refresh_worker_profile_env() -> None:
    """Overlay the current worker profile .env/config before creating a new agent."""
    profile = _worker_profile()
    if not profile:
        return
    profile_home = _profile_home(profile)
    os.environ["HERMES_HOME"] = str(profile_home)
    values = _read_dotenv(profile_home / ".env")
    for key, value in values.items():
        os.environ[key] = value
    _refresh_terminal_env()


@contextmanager
def _profile_env(profile: str | None):
    if _worker_profile():
        yield
        return
    original = _apply_profile_env(profile)
    env_snapshot = _apply_profile_dotenv(profile)
    try:
        yield
    finally:
        _restore_profile_dotenv(env_snapshot)
        _restore_profile_env(original)


def _refresh_terminal_env() -> None:
    """Bridge current worker HERMES_HOME/config.yaml terminal config to TERMINAL_* env vars.

    Worker startup first overlays the profile .env, then this function lets
    terminal config.yaml values override the matching terminal environment vars.
    """
    hermes_home = os.environ.get("HERMES_HOME", "")
    if not hermes_home:
        return
    config_path = Path(hermes_home) / "config.yaml"
    if not config_path.exists():
        return
    try:
        import yaml
        with open(config_path, encoding="utf-8") as f:
            cfg = yaml.safe_load(f) or {}
        terminal_cfg = cfg.get("terminal", {})
        if not isinstance(terminal_cfg, dict):
            return
        TERMINAL_ENV_MAP = {
            "backend": "TERMINAL_ENV",
            "cwd": "TERMINAL_CWD",
            "timeout": "TERMINAL_TIMEOUT",
            "lifetime_seconds": "TERMINAL_LIFETIME_SECONDS",
            "ssh_host": "TERMINAL_SSH_HOST",
            "ssh_user": "TERMINAL_SSH_USER",
            "ssh_port": "TERMINAL_SSH_PORT",
            "ssh_key": "TERMINAL_SSH_KEY",
            "docker_image": "TERMINAL_DOCKER_IMAGE",
            "docker_forward_env": "TERMINAL_DOCKER_FORWARD_ENV",
            "singularity_image": "TERMINAL_SINGULARITY_IMAGE",
            "modal_image": "TERMINAL_MODAL_IMAGE",
            "daytona_image": "TERMINAL_DAYTONA_IMAGE",
            "vercel_runtime": "TERMINAL_VERCEL_RUNTIME",
            "container_cpu": "TERMINAL_CONTAINER_CPU",
            "container_memory": "TERMINAL_CONTAINER_MEMORY",
            "container_disk": "TERMINAL_CONTAINER_DISK",
            "container_persistent": "TERMINAL_CONTAINER_PERSISTENT",
            "docker_volumes": "TERMINAL_DOCKER_VOLUMES",
            "docker_env": "TERMINAL_DOCKER_ENV",
            "docker_mount_cwd_to_workspace": "TERMINAL_DOCKER_MOUNT_CWD_TO_WORKSPACE",
            "docker_run_as_host_user": "TERMINAL_DOCKER_RUN_AS_HOST_USER",
            "sandbox_dir": "TERMINAL_SANDBOX_DIR",
            "persistent_shell": "TERMINAL_PERSISTENT_SHELL",
            "modal_mode": "TERMINAL_MODAL_MODE",
        }
        for cfg_key, env_var in TERMINAL_ENV_MAP.items():
            if cfg_key in terminal_cfg:
                val = terminal_cfg[cfg_key]
                if cfg_key == "cwd" and str(val) in {".", "auto", "cwd"}:
                    continue
                if cfg_key == "cwd" and isinstance(val, str):
                    val = os.path.expanduser(val)
                if isinstance(val, (list, dict)):
                    os.environ[env_var] = json.dumps(val)
                else:
                    os.environ[env_var] = str(val)
    except Exception:
        print(
            f"[hermes-bridge] Failed to refresh terminal env from {config_path}",
            file=sys.stderr,
            flush=True,
        )


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


def _discover_bridge_mcp_tools() -> list[str]:
    _ensure_agent_imports()
    try:
        from tools.mcp_tool import discover_mcp_tools

        tools = discover_mcp_tools()
        return list(tools) if isinstance(tools, list) else []
    except Exception as exc:
        print(
            f"[hermes_bridge] MCP tool discovery failed: {exc}",
            file=sys.stderr,
            flush=True,
        )
        return []


def _log_worker_startup_context(profile: str | None) -> None:
    profile_name = profile or _worker_profile() or "default"
    try:
        cfg = _load_cfg()
        enabled_toolsets = _load_enabled_toolsets()
        discovered_mcp_tools = _discover_bridge_mcp_tools()
        tool_names: list[str] = []
        tool_error: str | None = None
        try:
            from model_tools import get_tool_definitions

            tool_names = _tool_names_from_definitions(
                get_tool_definitions(
                    enabled_toolsets=enabled_toolsets,
                    quiet_mode=True,
                )
            )
        except Exception as exc:
            tool_error = str(exc)

        mcp_servers = cfg.get("mcp_servers") if isinstance(cfg.get("mcp_servers"), dict) else {}
        enabled_mcp_servers: list[str] = []
        disabled_mcp_servers: list[str] = []
        for name, server_cfg in mcp_servers.items():
            enabled = True
            if isinstance(server_cfg, dict):
                enabled = str(server_cfg.get("enabled", True)).strip().lower() not in {"0", "false", "no", "off"}
            (enabled_mcp_servers if enabled else disabled_mcp_servers).append(str(name))

        _bridge_log("bridge.worker.initialized", {
            "profile": profile_name,
            "platform": _bridge_platform(),
            "hermes_home": str(_hermes_home()),
            "base_hermes_home": str(_base_hermes_home()),
            "config_path": str(_hermes_home() / "config.yaml"),
            "model": _resolve_model(cfg),
            "enabled_toolsets": enabled_toolsets,
            "tool_count": len(tool_names),
            "tool_names": tool_names,
            "tool_error": tool_error,
            "mcp_server_count": len(mcp_servers),
            "mcp_servers": sorted(str(name) for name in mcp_servers),
            "enabled_mcp_servers": sorted(enabled_mcp_servers),
            "disabled_mcp_servers": sorted(disabled_mcp_servers),
            "mcp_discovered_tool_count": len(discovered_mcp_tools),
            "mcp_discovered_tool_names": discovered_mcp_tools,
            "mcp_tool_count": len(_mcp_tool_names_from_names(tool_names)),
            "mcp_tool_names": _mcp_tool_names_from_names(tool_names),
        })
    except Exception as exc:
        _bridge_log("bridge.worker.initialized", {
            "profile": profile_name,
            "error": str(exc),
        })


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
        self._db = SessionDbHolder()
        self._approval_requests: dict[str, queue.Queue[str]] = {}
        self._gateway_approval_requests: dict[str, str] = {}
        self._compression_requests: dict[str, queue.Queue[dict[str, Any]]] = {}
        self._clarify_requests: dict[str, queue.Queue[str]] = {}
        self._run_context = threading.local()
        self._approval_handlers: dict[str, Callable[..., str]] = {}
        self._exec_ask_depth = 0
        self._exec_ask_previous: str | None = None

    def get_or_create(
        self,
        session_id: str,
        profile: str | None = None,
        model: str | None = None,
        provider: str | None = None,
    ) -> AgentSession:
        requested_model = str(model or "").strip()
        requested_provider = str(provider or "").strip()
        with self._lock:
            existing = self._sessions.get(session_id)
            if existing is not None:
                # If profile changed, destroy old session and recreate
                config_changed = bool(
                    (profile and existing.config.get("profile") != profile)
                    or (requested_model and existing.config.get("model") != requested_model)
                    or (requested_provider and existing.config.get("provider") != requested_provider)
                )
                if config_changed:
                    if not existing.running:
                        self._destroy_session(session_id)
                    else:
                        existing.last_used_at = time.time()
                        return existing
                else:
                    existing.last_used_at = time.time()
                    return existing

            _ensure_agent_imports()
            _suppress_bridge_platform_hint()
            from run_agent import AIAgent

            with _profile_env(profile):
                _refresh_worker_profile_env()
                discovered_mcp_tools = _discover_bridge_mcp_tools()
                cfg = _load_cfg()
                resolved_model = requested_model or _resolve_model(cfg)
                runtime = _resolve_runtime(resolved_model, requested_provider or None)
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
                    thinking_callback=self._make_thinking_callback(session_id),
                    reasoning_callback=self._text_event_callback(session_id, "reasoning.delta"),
                    tool_progress_callback=self._tool_progress_callback(session_id),
                    tool_start_callback=self._tool_start_callback(session_id),
                    tool_complete_callback=self._tool_complete_callback(session_id),
                    clarify_callback=self._clarify_callback(session_id),
                )
                agent.compression_enabled = False
                self._install_compression_hook(agent, session_id)
                mcp_tool_names = self._mcp_tool_names(self._agent_tool_names(getattr(agent, "tools", None) or []))

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
                        "mcp_tool_count": len(discovered_mcp_tools),
                        "active_mcp_tool_count": len(mcp_tool_names),
                        "db_error": self._db.error,
                    },
                )
                self._sessions[session_id] = session
                return session

    def _install_compression_hook(self, agent: Any, session_id: str) -> None:
        original = getattr(agent, "_compress_context", None)
        if not callable(original):
            return

        def wrapped_compress_context(messages, system_message, **kwargs):
            before_count = len(messages) if isinstance(messages, list) else 0
            approx_tokens = kwargs.get("approx_tokens")
            if not isinstance(approx_tokens, int) or approx_tokens <= 0:
                approx_tokens = self._estimate_context_tokens(agent, messages, system_message)
            print(
                "[hermes_bridge] compression requested "
                f"session={session_id} messages={before_count} "
                f"tokens={approx_tokens if approx_tokens is not None else 'unknown'} "
                f"focus={kwargs.get('focus_topic') or ''}",
                file=sys.stderr,
                flush=True,
            )
            request_id = uuid.uuid4().hex
            response_queue: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=1)
            with self._lock:
                self._compression_requests[request_id] = response_queue
            self._append_event(session_id, {
                "event": "bridge.compression.requested",
                "request_id": request_id,
                "message_count": before_count,
                "approx_tokens": approx_tokens,
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
                result_approx_tokens = self._estimate_context_tokens(agent, compressed_messages, next_system_message)
                self._append_event(session_id, {
                    "event": "bridge.compression.completed",
                    "request_id": request_id,
                    "message_count": before_count,
                    "result_messages": len(compressed_messages),
                    "approx_tokens": approx_tokens,
                    "result_approx_tokens": result_approx_tokens,
                    "compressed": True,
                })
                return compressed_messages, next_system_message
            except queue.Empty:
                self._append_event(session_id, {
                    "event": "bridge.compression.failed",
                    "request_id": request_id,
                    "message_count": before_count,
                    "approx_tokens": approx_tokens,
                    "error": "bridge compression timed out",
                })
                raise RuntimeError("bridge compression timed out")
            except Exception as exc:
                self._append_event(session_id, {
                    "event": "bridge.compression.failed",
                    "request_id": request_id,
                    "message_count": before_count,
                    "approx_tokens": approx_tokens,
                    "error": str(exc),
                })
                raise
            finally:
                with self._lock:
                    self._compression_requests.pop(request_id, None)

        agent._compress_context = wrapped_compress_context

    def _agent_system_prompt(self, agent: Any, system_message: Any = None) -> str:
        prompt = str(getattr(agent, "_cached_system_prompt", "") or "")
        if prompt:
            return prompt
        try:
            build_prompt = getattr(agent, "_build_system_prompt", None)
            if callable(build_prompt):
                return str(build_prompt(system_message) or "")
        except Exception:
            return str(system_message or "")
        return str(system_message or "")

    def _agent_tool_names(self, tools: Any) -> list[str]:
        return _tool_names_from_definitions(tools)

    def _mcp_tool_names(self, tool_names: Any) -> list[str]:
        return _mcp_tool_names_from_names(tool_names)

    def _estimate_context_info(self, agent: Any, messages: Any, system_message: Any = None) -> dict[str, Any]:
        try:
            from agent.model_metadata import estimate_request_tokens_rough
        except Exception:
            return {}

        prompt = self._agent_system_prompt(agent, system_message)
        tools = getattr(agent, "tools", None) or []
        message_list = messages if isinstance(messages, list) else []
        try:
            tool_names = self._agent_tool_names(tools)
            token_count = estimate_request_tokens_rough(message_list, system_prompt=prompt, tools=tools or None)
            fixed_context_tokens = estimate_request_tokens_rough([], system_prompt=prompt, tools=tools or None)
            system_prompt_tokens = estimate_request_tokens_rough([], system_prompt=prompt, tools=None)
            tool_tokens = max(0, int(fixed_context_tokens or 0) - int(system_prompt_tokens or 0))
            return {
                "token_count": int(token_count) if isinstance(token_count, (int, float)) and token_count > 0 else None,
                "fixed_context_tokens": int(fixed_context_tokens) if isinstance(fixed_context_tokens, (int, float)) and fixed_context_tokens >= 0 else None,
                "system_prompt_tokens": int(system_prompt_tokens) if isinstance(system_prompt_tokens, (int, float)) and system_prompt_tokens >= 0 else None,
                "tool_tokens": tool_tokens,
                "message_count": len(message_list),
                "tool_count": len(tools) if isinstance(tools, list) else 0,
                "tool_names": tool_names,
                "mcp_tool_count": len(self._mcp_tool_names(tool_names)),
                "mcp_tool_names": self._mcp_tool_names(tool_names),
                "system_prompt_chars": len(prompt),
            }
        except Exception:
            return {}

    def _estimate_context_tokens(self, agent: Any, messages: Any, system_message: Any = None) -> int | None:
        token_count = self._estimate_context_info(agent, messages, system_message).get("token_count")
        return int(token_count) if isinstance(token_count, (int, float)) and token_count > 0 else None

    def _bridge_context_ready_event(self, session: AgentSession, instructions: str | None, profile: str | None) -> dict[str, Any]:
        info = self._estimate_context_info(session.agent, [], instructions)
        event = {
            "event": "bridge.context.ready",
            "session_id": session.session_id,
            "profile": profile or session.config.get("profile") or "default",
            "model": session.config.get("model"),
            "provider": session.config.get("provider"),
            **info,
        }
        session.config["context_info"] = event
        return event

    def estimate_context(
        self,
        session_id: str,
        messages: list[dict[str, Any]] | None = None,
        instructions: str | None = None,
        profile: str | None = None,
        model: str | None = None,
        provider: str | None = None,
    ) -> dict[str, Any]:
        session = self.get_or_create(session_id, profile=profile, model=model, provider=provider)
        context_info = self._estimate_context_info(session.agent, messages or [], instructions)
        print(
            "[hermes_bridge] context estimate "
            f"session={session_id} profile={profile or 'default'} "
            f"messages={len(messages or [])} system_prompt_chars={context_info.get('system_prompt_chars') or 0} "
            f"tools={context_info.get('tool_count') or 0} "
            f"fixed_tokens={context_info.get('fixed_context_tokens') if context_info.get('fixed_context_tokens') is not None else 'unknown'} "
            f"tokens={context_info.get('token_count') if context_info.get('token_count') is not None else 'unknown'}",
            file=sys.stderr,
            flush=True,
        )
        return {
            "session_id": session_id,
            "profile": profile or session.config.get("profile") or "default",
            "model": session.config.get("model"),
            "provider": session.config.get("provider"),
            **context_info,
        }

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

    def _make_thinking_callback(self, session_id: str):
        """Create a thinking callback that never forwards spinner text as content.

        The hermes-agent CLI uses thinking_callback for its KawaiiSpinner TUI
        widget — sending decorative text like "(◕‿◕✿) pondering..." during
        API calls.  This is pure CLI UX decoration; it has no place in Web UI
        conversation history.

        Prior behaviour forwarded this text as thinking.delta events, which the
        frontend stored in the message reasoning field.  Over long conversations
        this contaminated the model's context: the LLM learned to reproduce
        kaomoji patterns, creating a self-reinforcing degradation loop.

        This callback sends empty text unconditionally.  The model's real
        reasoning content arrives through reasoning_callback → reasoning.delta,
        which is unaffected.
        """
        def callback(text=None):
            self._append_event(session_id, {"event": "thinking.delta", "text": ""})

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
            if event_type in (None, "tool.started", "tool.completed") or str(event_type or "").startswith("subagent."):
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

            if str(event_type or "").startswith("subagent."):
                payload = {
                    "event": str(event_type),
                    "tool_name": str(function_name) if function_name else "",
                    "text": str(preview) if preview is not None else "",
                    "args": _jsonable(function_args) if function_args else {},
                }
                for key, value in kwargs.items():
                    payload[str(key)] = _jsonable(value)
                self._append_event(session_id, payload)
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
                "timeout_ms": APPROVAL_TIMEOUT_MS,
            })
            try:
                choice = response_queue.get(timeout=APPROVAL_TIMEOUT_SECONDS)
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

    def _clarify_callback(self, session_id: str):
        def callback(question: str, choices: list[str] | None = None) -> str:
            clarify_id = uuid.uuid4().hex
            response_queue: queue.Queue[str] = queue.Queue(maxsize=1)
            with self._lock:
                self._clarify_requests[clarify_id] = response_queue
            self._append_event(session_id, {
                "event": "clarify.requested",
                "clarify_id": clarify_id,
                "question": str(question or ""),
                "choices": list(choices) if choices else None,
                "timeout_ms": 300_000,
            })
            try:
                user_response = response_queue.get(timeout=300)
            except queue.Empty:
                user_response = "[user did not respond within 5m]"
            finally:
                with self._lock:
                    self._clarify_requests.pop(clarify_id, None)
            return user_response

        return callback

    def _approval_dispatcher(self, command: str, description: str, *, allow_permanent: bool = True) -> str:
        session_id = str(getattr(self._run_context, "session_id", "") or "")
        if not session_id:
            return "deny"
        with self._lock:
            handler = self._approval_handlers.get(session_id)
        if handler is None:
            return "deny"
        return handler(command, description, allow_permanent=allow_permanent)

    def _install_approval_dispatcher_for_current_thread(self) -> None:
        from tools.terminal_tool import set_approval_callback

        # terminal_tool stores callbacks in threading.local(), so each run
        # thread must bind the shared dispatcher for itself.
        set_approval_callback(self._approval_dispatcher)

    def _enter_exec_ask_scope(self) -> None:
        with self._lock:
            if self._exec_ask_depth == 0:
                self._exec_ask_previous = os.environ.get("HERMES_EXEC_ASK")
                os.environ["HERMES_EXEC_ASK"] = "1"
            self._exec_ask_depth += 1

    def _exit_exec_ask_scope(self) -> None:
        with self._lock:
            if self._exec_ask_depth <= 0:
                return
            self._exec_ask_depth -= 1
            if self._exec_ask_depth > 0:
                return
            previous = self._exec_ask_previous
            self._exec_ask_previous = None
            if previous is None:
                os.environ.pop("HERMES_EXEC_ASK", None)
            else:
                os.environ["HERMES_EXEC_ASK"] = previous

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
        storage_message: Any | None,
        conversation_history: list[dict[str, Any]] | None,
        profile: str | None,
        source: str | None = None,
    ) -> bool:
        persist_message = storage_message if storage_message is not None else message
        user_content = str(persist_message) if not isinstance(persist_message, dict) else str(persist_message.get("content", persist_message))
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
                    source=source or _bridge_platform(),
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
        storage_message: Any | None = None,
        instructions: str | None = None,
        conversation_history: list[dict[str, Any]] | None = None,
        profile: str | None = None,
        force_compress: bool = False,
        model: str | None = None,
        provider: str | None = None,
        source: str | None = None,
    ) -> RunRecord:
        session = self.get_or_create(session_id, profile=profile, model=model, provider=provider)
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
            context_event = self._bridge_context_ready_event(session, instructions, profile)
            if context_event:
                record.events.append(_jsonable(context_event))

        thread = threading.Thread(
            target=self._run_chat,
            args=(session, record, message, storage_message, instructions, conversation_history, profile, force_compress, source),
            daemon=True,
            name=f"hermes-bridge-run-{run_id[:8]}",
        )
        thread.start()
        return record

    def _run_chat(self, session: AgentSession, record: RunRecord, message: Any, storage_message: Any | None = None, instructions: str | None = None, conversation_history: list[dict[str, Any]] | None = None, profile: str | None = None, force_compress: bool = False, source: str | None = None) -> None:
        with _profile_env(profile):
            def stream_callback(delta: str) -> None:
                with self._lock:
                    text = str(delta)
                    # Keep `deltas` for the aggregated `output`/resume snapshot,
                    # AND record each text chunk as an ordered event in the SAME
                    # `events` list used by tool.started/tool.completed. Text and
                    # tool events were previously tracked in two parallel lists
                    # with no relative ordering, so when the model interleaved
                    # narration and tool calls ("text → tool → more text") the
                    # consumer reordered them — processing all events before the
                    # aggregated delta — which visibly split a word across the
                    # tool boundary. Recording text as ordered events preserves
                    # the true interleaving.
                    record.deltas.append(text)
                    if text:
                        record.events.append({"event": "stream.delta", "delta": text})

            approval_session_token = None
            registered_gateway_approval_session = None
            exec_ask_scope_entered = False
            try:
                try:
                    self._enter_exec_ask_scope()
                    exec_ask_scope_entered = True
                    self._install_approval_dispatcher_for_current_thread()
                    with self._lock:
                        self._approval_handlers[session.session_id] = self._approval_callback(session.session_id)
                    self._run_context.session_id = session.session_id
                except Exception:
                    self._run_context.session_id = session.session_id
                try:
                    from tools.approval import register_gateway_notify, set_current_session_key

                    approval_session_token = set_current_session_key(session.session_id)
                    register_gateway_notify(session.session_id, self._gateway_approval_notify(session.session_id))
                    registered_gateway_approval_session = session.session_id
                except Exception:
                    pass
                self._prepersist_user_message(session, message, storage_message, conversation_history, profile, source)
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
                with self._lock:
                    self._approval_handlers.pop(session.session_id, None)
                try:
                    del self._run_context.session_id
                except AttributeError:
                    pass
                if approval_session_token is not None:
                    try:
                        from tools.approval import reset_current_session_key, unregister_gateway_notify

                        if registered_gateway_approval_session is not None:
                            unregister_gateway_notify(registered_gateway_approval_session)
                        reset_current_session_key(approval_session_token)
                    except Exception:
                        pass
                if exec_ask_scope_entered:
                    self._exit_exec_ask_scope()

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

    def respond_clarify(self, clarify_id: str, response: str) -> dict[str, Any]:
        with self._lock:
            response_queue = self._clarify_requests.get(clarify_id)
        if response_queue is None:
            return {"clarify_id": clarify_id, "resolved": False}
        try:
            response_queue.put_nowait(response)
        except queue.Full:
            pass
        return {"clarify_id": clarify_id, "resolved": True}

    def get_history(self, session_id: str) -> dict[str, Any]:
        with self._lock:
            session = self._sessions.get(session_id)
        if session is None:
            raise KeyError(f"unknown session: {session_id}")
        with session.lock:
            return {"session_id": session_id, "history": copy.deepcopy(session.history)}

    def dispatch_command(self, session_id: str, command: str, profile: str | None = None) -> dict[str, Any]:
        raw = str(command or "").strip()
        if raw.startswith("/"):
            raw = raw[1:].strip()
        if not raw:
            raise ValueError("command is required")

        parts = raw.split(maxsplit=1)
        name = parts[0].lstrip("/").strip().lower()
        arg = parts[1] if len(parts) > 1 else ""

        with _profile_env(profile):
            if name == "goal":
                return self._dispatch_goal_command(session_id, arg)
            if name == "subgoal":
                return self._dispatch_subgoal_command(session_id, arg)

            try:
                try:
                    from agent.skill_bundles import (
                        build_bundle_invocation_message,
                        resolve_bundle_command_key,
                    )

                    bundle_key = resolve_bundle_command_key(name)
                    if bundle_key:
                        bundle_result = build_bundle_invocation_message(
                            bundle_key,
                            arg,
                            task_id=session_id,
                        )
                        if bundle_result:
                            message, loaded_names, missing_names = bundle_result
                            return {
                                "session_id": session_id,
                                "command": name,
                                "handled": True,
                                "type": "bundle",
                                "message": message,
                                "loaded": loaded_names,
                                "missing": missing_names,
                            }
                except ImportError:
                    pass

                from agent.skill_commands import (
                    build_skill_invocation_message,
                    resolve_skill_command_key,
                )

                key = resolve_skill_command_key(name)
                if key:
                    message = build_skill_invocation_message(
                        key,
                        arg,
                        task_id=session_id,
                        runtime_note=(
                            "If you need user clarification, call the clarify tool. "
                            "Do not output raw JSON question/choices payloads as the final response."
                        ),
                    )
                    if message:
                        return {
                            "session_id": session_id,
                            "command": name,
                            "handled": True,
                            "type": "skill",
                            "message": message,
                        }
            except Exception as exc:
                raise RuntimeError(f"skill command dispatch failed: {exc}") from exc

        return {
            "session_id": session_id,
            "command": name,
            "handled": False,
            "message": f"not a supported bridge command: /{name}",
        }

    def _goal_max_turns_from_config(self) -> int:
        try:
            from hermes_cli.config import load_config

            goals_cfg = (load_config() or {}).get("goals") or {}
            return int(goals_cfg.get("max_turns", 20) or 20)
        except Exception:
            return 20

    def _goal_manager(self, session_id: str):
        from hermes_cli.goals import GoalManager

        return GoalManager(
            session_id=session_id,
            default_max_turns=self._goal_max_turns_from_config(),
        )

    def _dispatch_goal_command(self, session_id: str, arg: str) -> dict[str, Any]:
        mgr = self._goal_manager(session_id)
        clean_arg = str(arg or "").strip()
        lower = clean_arg.lower()

        if not clean_arg or lower == "status":
            return {
                "session_id": session_id,
                "command": "goal",
                "handled": True,
                "type": "goal",
                "action": "goal_status",
                "message": mgr.status_line(),
            }

        if lower == "pause":
            state = mgr.pause(reason="user-paused")
            return {
                "session_id": session_id,
                "command": "goal",
                "handled": True,
                "type": "goal",
                "action": "pause",
                "message": f"⏸ Goal paused: {state.goal}" if state else "No goal set.",
                "clear_goal_continuations": True,
            }

        if lower == "resume":
            state = mgr.resume()
            prompt = mgr.next_continuation_prompt() if state else None
            return {
                "session_id": session_id,
                "command": "goal",
                "handled": True,
                "type": "goal",
                "action": "resume",
                "message": f"▶ Goal resumed: {state.goal}" if state else "No goal to resume.",
                "kickoff_prompt": prompt,
                "max_turns": state.max_turns if state else None,
            }

        if lower in {"clear", "stop", "done"}:
            had = mgr.has_goal()
            mgr.clear()
            return {
                "session_id": session_id,
                "command": "goal",
                "handled": True,
                "type": "goal",
                "action": "clear",
                "message": "✓ Goal cleared." if had else "No active goal.",
                "clear_goal_continuations": True,
            }

        try:
            state = mgr.set(clean_arg)
        except ValueError as exc:
            return {
                "session_id": session_id,
                "command": "goal",
                "handled": True,
                "type": "goal",
                "action": "set",
                "message": f"Invalid goal: {exc}",
            }

        return {
            "session_id": session_id,
            "command": "goal",
            "handled": True,
            "type": "goal",
            "action": "set",
            "message": (
                f"⊙ Goal set ({state.max_turns}-turn budget): {state.goal}\n"
                "After each turn, a judge model will check if the goal is done. "
                "Hermes keeps working until it is, you pause/clear it, or the budget is exhausted."
            ),
            "kickoff_prompt": state.goal,
            "max_turns": state.max_turns,
        }

    def _dispatch_subgoal_command(self, session_id: str, arg: str) -> dict[str, Any]:
        mgr = self._goal_manager(session_id)
        clean_arg = str(arg or "").strip()
        if not mgr.has_goal():
            return {
                "session_id": session_id,
                "command": "subgoal",
                "handled": True,
                "type": "goal",
                "action": "subgoal",
                "message": "No active goal. Set one with /goal <text>.",
            }

        if not clean_arg:
            return {
                "session_id": session_id,
                "command": "subgoal",
                "handled": True,
                "type": "goal",
                "action": "subgoal_status",
                "message": f"{mgr.status_line()}\n{mgr.render_subgoals()}",
            }

        tokens = clean_arg.split(None, 1)
        verb = tokens[0].lower()
        rest = tokens[1].strip() if len(tokens) > 1 else ""

        if verb == "remove":
            if not rest:
                message = "Usage: /subgoal remove <n>"
            else:
                try:
                    idx = int(rest.split()[0])
                    removed = mgr.remove_subgoal(idx)
                    message = f"✓ Removed subgoal {idx}: {removed}"
                except ValueError:
                    message = "/subgoal remove: <n> must be an integer (1-based index)."
                except (IndexError, RuntimeError) as exc:
                    message = f"/subgoal remove: {exc}"
            return {
                "session_id": session_id,
                "command": "subgoal",
                "handled": True,
                "type": "goal",
                "action": "subgoal_remove",
                "message": message,
            }

        if verb == "clear":
            try:
                prev = mgr.clear_subgoals()
                message = f"✓ Cleared {prev} subgoal{'s' if prev != 1 else ''}." if prev else "No subgoals to clear."
            except RuntimeError as exc:
                message = f"/subgoal clear: {exc}"
            return {
                "session_id": session_id,
                "command": "subgoal",
                "handled": True,
                "type": "goal",
                "action": "subgoal_clear",
                "message": message,
            }

        try:
            text = mgr.add_subgoal(clean_arg)
            idx = len(mgr.state.subgoals) if mgr.state else 0
            message = f"✓ Added subgoal {idx}: {text}"
        except (ValueError, RuntimeError) as exc:
            message = f"/subgoal: {exc}"

        return {
            "session_id": session_id,
            "command": "subgoal",
            "handled": True,
            "type": "goal",
            "action": "subgoal_add",
            "message": message,
        }

    def evaluate_goal(self, session_id: str, final_response: str, profile: str | None = None) -> dict[str, Any]:
        with _profile_env(profile):
            mgr = self._goal_manager(session_id)
            if not mgr.is_active():
                return {
                    "session_id": session_id,
                    "handled": True,
                    "active": False,
                    "should_continue": False,
                    "continuation_prompt": None,
                    "message": "",
                    "verdict": "inactive",
                }
            decision = mgr.evaluate_after_turn(str(final_response or ""), user_initiated=True)
            return {
                "session_id": session_id,
                "handled": True,
                "active": mgr.is_active(),
                **decision,
            }

    def pause_goal(self, session_id: str, reason: str, profile: str | None = None) -> dict[str, Any]:
        with _profile_env(profile):
            clean_reason = str(reason or "").strip() or "paused"
            mgr = self._goal_manager(session_id)
            state = mgr.pause(reason=clean_reason)
            return {
                "session_id": session_id,
                "command": "goal",
                "handled": True,
                "type": "goal",
                "action": "pause",
                "active": mgr.is_active(),
                "status": state.status if state else None,
                "reason": clean_reason,
                "message": f"⏸ Goal paused: {state.goal}" if state else "No goal set.",
                "clear_goal_continuations": True,
            }

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
            with self.pool._lock:
                sessions = list(self.pool._sessions.values())
            running_sessions = sum(1 for session in sessions if session.running)
            return {
                "pong": True,
                "time": time.time(),
                "pid": os.getpid(),
                "agent_root": str(_agent_root()),
                "profile": _worker_profile() or "default",
                "hermes_home": str(_hermes_home()),
                "session_count": len(sessions),
                "running_session_count": running_sessions,
            }

        if action == "chat":
            session_id = str(req.get("session_id") or "").strip() or uuid.uuid4().hex
            message = req.get("message", req.get("input", ""))
            storage_message = req.get("storage_message")
            instructions = req.get("instructions") or req.get("system_message")
            conversation_history = req.get("conversation_history")
            profile = req.get("profile")
            model = req.get("model")
            provider = req.get("provider")
            source = req.get("source")
            record = self.pool.start_chat(
                session_id,
                message,
                storage_message,
                instructions,
                conversation_history,
                profile,
                bool(req.get("force_compress")),
                model,
                provider,
                source,
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

        if action == "context_estimate":
            session_id = str(req.get("session_id") or "").strip() or uuid.uuid4().hex
            messages = req.get("messages") or req.get("conversation_history") or []
            if not isinstance(messages, list):
                raise ValueError("messages must be a list")
            return self.pool.estimate_context(
                session_id,
                messages=messages,
                instructions=req.get("instructions") or req.get("system_message"),
                profile=req.get("profile"),
                model=req.get("model"),
                provider=req.get("provider"),
            )

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

        if action == "clarify_respond":
            clarify_id = str(req.get("clarify_id") or "").strip()
            if not clarify_id:
                raise ValueError("clarify_id is required")
            response = str(req.get("response") or "").strip()
            return self.pool.respond_clarify(clarify_id, response)

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

        if action == "command":
            session_id = str(req.get("session_id") or "").strip()
            if not session_id:
                raise ValueError("session_id is required")
            return self.pool.dispatch_command(
                session_id,
                str(req.get("command") or ""),
                req.get("profile"),
            )

        if action == "goal_evaluate":
            session_id = str(req.get("session_id") or "").strip()
            if not session_id:
                raise ValueError("session_id is required")
            return self.pool.evaluate_goal(
                session_id,
                str(req.get("final_response") or ""),
                req.get("profile"),
            )

        if action == "goal_pause":
            session_id = str(req.get("session_id") or "").strip()
            if not session_id:
                raise ValueError("session_id is required")
            return self.pool.pause_goal(
                session_id,
                str(req.get("reason") or ""),
                req.get("profile"),
            )

        if action == "status":
            return self.pool.status(str(req.get("session_id") or ""))

        if action == "destroy":
            return self.pool.destroy(str(req.get("session_id") or ""))

        if action == "destroy_all":
            return self.pool.destroy_all()

        if action == "list":
            return self.pool.list_sessions()

        if action == "shutdown":
            self._stop.set()
            return {"status": "shutting_down"}

        # ───── MCP Management (forwarded from broker) ─────
        if action.startswith("mcp_"):
            return self._handle_mcp_action(action, req, req.get("profile"))

        raise ValueError(f"unknown action: {action}")

    # ───── MCP Management Methods (for BridgeServer worker process) ─────

    def _read_mcp_config(self, profile=None):
        """Read config.yaml for the given profile."""
        import yaml
        config_path = _profile_home(profile) / "config.yaml"
        try:
            with open(config_path, encoding="utf-8") as f:
                return yaml.safe_load(f) or {}
        except Exception:
            return {}

    def _save_mcp_config(self, cfg, profile=None):
        """Save config.yaml for the given profile using atomic write."""
        import yaml
        from utils import atomic_yaml_write
        config_path = _profile_home(profile) / "config.yaml"
        config_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            atomic_yaml_write(config_path, cfg, sort_keys=False)
        except Exception as e:
            raise RuntimeError(f"Failed to save config to {config_path}: {e}")

    @staticmethod
    def _run_mcp_discovery_bg(discover_fn, profile: str | None = None):
        """Run MCP discovery in a background thread to avoid blocking."""
        def _bg():
            original = _apply_profile_env(profile)
            try:
                discover_fn()
            except Exception as e:
                print(f"[mcp-discovery-bg] failed: {e}", file=sys.stderr, flush=True)
            finally:
                _restore_profile_env(original)
        threading.Thread(target=_bg, daemon=True).start()

    def _handle_mcp_action(self, action: str, req: dict[str, Any], profile: str | None = None) -> dict[str, Any]:
        """Handle MCP management actions in worker process."""
        try:
            from tools.mcp_tool import discover_mcp_tools, register_mcp_servers, _run_on_mcp_loop, _servers, _lock
        except ImportError:
            return {"error": "MCP tool module not available", "ok": False}

        if profile is None:
            profile = _worker_profile() or "default"

        dispatch = {
            "mcp_list":            lambda: self._mcp_list(profile, _servers, _lock),
            "mcp_server_add":      lambda: self._mcp_server_add(req, profile, discover_mcp_tools),
            "mcp_server_update":   lambda: self._mcp_server_update(req, profile, _servers, _lock, _run_on_mcp_loop, discover_mcp_tools),
            "mcp_server_remove":   lambda: self._mcp_server_remove(req, profile, _servers, _lock, _run_on_mcp_loop),
            "mcp_server_test":     lambda: self._mcp_server_test(req, _servers, _lock),
            "mcp_tools_list":      lambda: self._mcp_tools_list(req, profile, _servers, _lock),
            "mcp_reload":          lambda: self._mcp_reload(req, profile, _servers, _lock, _run_on_mcp_loop, discover_mcp_tools, register_mcp_servers),
        }
        handler = dispatch.get(action)
        if handler:
            return handler()
        return {"error": f"unknown MCP action: {action}", "ok": False}

    # ───── MCP sub-handlers ─────

    def _build_server_entry(self, name: str, cfg: dict, connected: bool = False,
                            tools_count: int = 0, registered_count: int = 0,
                            raw_names: list | None = None, registered_names: list | None = None,
                            tool_details: list | None = None,
                            error: str | None = None) -> dict[str, Any]:
        """Build a normalized server entry dict for API responses."""
        transport = "http" if cfg.get("url") else "stdio"
        return {
            "name": name,
            "transport": transport,
            "connected": connected,
            "tools": tools_count,
            "tools_registered": registered_count,
            "tool_names": raw_names or [],
            "tool_names_registered": registered_names or [],
            "tool_details": tool_details or [],
            "error": error,
            "raw_config": cfg if isinstance(cfg, dict) else {},
        }

    def _mcp_list(self, profile: str, _servers, _lock) -> dict[str, Any]:
        servers = []
        total_tools = 0

        config = self._read_mcp_config(profile)
        mcp_configs = config.get("mcp_servers", {}) or {} if config else {}
        profile_server_names = set(mcp_configs.keys())

        with _lock:
            server_snapshot = list(_servers.items())
        for name, task in server_snapshot:
            if name not in profile_server_names:
                continue
            raw_tool_names = []
            try:
                for mcp_tool in getattr(task, "_tools", []):
                    if hasattr(mcp_tool, "name"):
                        raw_tool_names.append(mcp_tool.name)
            except Exception:
                pass
            registered = list(getattr(task, "_registered_tool_names", None) or [])
            if not registered:
                registered = list(raw_tool_names)
            t = getattr(task, "_task", None)
            connected = bool(t and not t.done())
            err = getattr(task, "_error", None)
            cfg = getattr(task, "_config", {})
            # Build filtered tool_details (name + description) for card display
            srv_cfg = mcp_configs.get(name, {}) if isinstance(mcp_configs.get(name), dict) else {}
            tools_filter = srv_cfg.get("tools") or {}
            include_set = set(tools_filter.get("include") or [])
            exclude_set = set(tools_filter.get("exclude") or [])
            tool_details = []
            try:
                for mcp_tool in getattr(task, "_tools", []):
                    tname = getattr(mcp_tool, "name", "?")
                    if include_set and tname not in include_set:
                        continue
                    if exclude_set and tname in exclude_set:
                        continue
                    tool_details.append({
                        "name": tname,
                        "description": getattr(mcp_tool, "description", ""),
                    })
            except Exception:
                pass
            entry = self._build_server_entry(
                name, cfg, connected=connected,
                tools_count=len(raw_tool_names), registered_count=len(registered),
                raw_names=raw_tool_names, registered_names=registered,
                tool_details=tool_details,
                error=str(err) if err else None,
            )
            servers.append(entry)
            total_tools += len(registered)

        # Add servers from config that are not in runtime _servers
        if config:
            existing = {s["name"] for s in servers}
            for name, cfg in mcp_configs.items():
                if name not in existing and isinstance(cfg, dict):
                    servers.append(self._build_server_entry(name, cfg))

        return {"servers": servers, "total_tools": total_tools, "ok": True}

    def _mcp_server_add(self, req: dict, profile: str, discover_mcp_tools) -> dict[str, Any]:
        name = str(req.get("name") or "").strip()
        config = req.get("config", {})
        if not name or not isinstance(config, dict):
            return {"error": "name and config are required", "ok": False}

        cfg = self._read_mcp_config(profile)
        if not cfg:
            return {"error": "config.yaml not found", "ok": False}

        mcp_servers = cfg.setdefault("mcp_servers", {})
        if not isinstance(mcp_servers, dict):
            mcp_servers = {}
            cfg["mcp_servers"] = mcp_servers
        if name in mcp_servers:
            return {"error": f"server '{name}' already exists, use update instead", "ok": False}
        mcp_servers[name] = config

        self._save_mcp_config(cfg, profile)
        self._run_mcp_discovery_bg(discover_mcp_tools, profile)

        return {"ok": True, "name": name}

    @staticmethod
    def _shutdown_mcp_server(name: str, _servers, _lock, run_on_mcp_loop) -> bool:
        with _lock:
            task = _servers.get(name)
        if task is None:
            return False

        try:
            run_on_mcp_loop(lambda: task.shutdown(), timeout=15)
        except Exception as e:
            print(f"[mcp-server-shutdown] failed for {name}: {e}", file=sys.stderr, flush=True)
        finally:
            with _lock:
                if _servers.get(name) is task:
                    _servers.pop(name, None)
        return True

    def _shutdown_mcp_servers(self, names: list[str], _servers, _lock, run_on_mcp_loop) -> int:
        stopped = 0
        for name in names:
            if self._shutdown_mcp_server(name, _servers, _lock, run_on_mcp_loop):
                stopped += 1
        return stopped

    def _mcp_server_update(self, req: dict, profile: str, _servers, _lock, run_on_mcp_loop, discover_mcp_tools) -> dict[str, Any]:
        name = str(req.get("name") or "").strip()
        config = req.get("config", {})
        if not name or not isinstance(config, dict):
            return {"error": "name and config are required", "ok": False}

        cfg = self._read_mcp_config(profile)
        if not cfg:
            return {"error": "config.yaml not found", "ok": False}

        mcp_servers = cfg.setdefault("mcp_servers", {})
        if not isinstance(mcp_servers, dict):
            mcp_servers = {}
            cfg["mcp_servers"] = mcp_servers
        if name not in mcp_servers:
            return {"error": f"server \'{name}\' not found in config", "ok": False}

        mcp_servers[name] = config

        self._save_mcp_config(cfg, profile)

        self._shutdown_mcp_server(name, _servers, _lock, run_on_mcp_loop)

        self._run_mcp_discovery_bg(discover_mcp_tools, profile)

        return {"ok": True}

    def _mcp_server_remove(self, req: dict, profile: str, _servers, _lock, run_on_mcp_loop) -> dict[str, Any]:
        name = str(req.get("name") or "").strip()
        if not name:
            return {"error": "name is required", "ok": False}

        # Write config first, then remove from memory
        cfg = self._read_mcp_config(profile)
        if cfg:
            mcp_servers = cfg.get("mcp_servers", {})
            if isinstance(mcp_servers, dict) and name in mcp_servers:
                del mcp_servers[name]
                self._save_mcp_config(cfg, profile)

        self._shutdown_mcp_server(name, _servers, _lock, run_on_mcp_loop)

        return {"ok": True}

    def _mcp_server_test(self, req: dict, _servers, _lock) -> dict[str, Any]:
        name = str(req.get("name") or "").strip()
        if not name:
            return {"error": "name is required", "ok": False}

        with _lock:
            task = _servers.get(name)
        if not task:
            return {"error": f"server \'{name}\' is not connected", "ok": False}

        tool_names = []
        try:
            for mcp_tool in getattr(task, "_tools", []):
                if hasattr(mcp_tool, "name"):
                    tool_names.append(mcp_tool.name)
        except Exception as e:
            return {"error": f"failed to list tools: {e}", "ok": False}

        return {"ok": True, "tools": tool_names}

    def _mcp_tools_list(self, req: dict, profile: str, _servers, _lock) -> dict[str, Any]:
        server_filter = str(req.get("server") or "").strip() or None
        results = []

        config = self._read_mcp_config(profile)
        mcp_configs = config.get("mcp_servers", {}) or {} if config else {}
        profile_server_names = set(mcp_configs.keys())

        with _lock:
            server_snapshot = list(_servers.items())
        for sname, task in server_snapshot:
            if sname not in profile_server_names:
                continue
            if server_filter and sname != server_filter:
                continue
            registered = set(getattr(task, "_registered_tool_names", None) or [])
            tools = []
            srv_cfg = mcp_configs.get(sname, {}) if isinstance(mcp_configs.get(sname), dict) else {}
            tools_filter = srv_cfg.get("tools") or {}
            include_set = set(tools_filter.get("include") or [])
            exclude_set = set(tools_filter.get("exclude") or [])
            def _should_include(tn):
                if include_set:
                    return tn in include_set
                if exclude_set:
                    return tn not in exclude_set
                return True
            try:
                for mcp_tool in getattr(task, "_tools", []):
                    tname = getattr(mcp_tool, "name", "?")
                    if not _should_include(tname):
                        continue
                    tools.append({
                        "name": tname,
                        "description": getattr(mcp_tool, "description", ""),
                        "input_schema": getattr(mcp_tool, "inputSchema", {}),
                    })
            except Exception as e:
                results.append({"server": sname, "tools": [], "error": str(e)})
                continue
            results.append({"server": sname, "tools": tools})

        return {"ok": True, "results": results}

    def _mcp_reload(self, req: dict, profile: str, _servers, _lock, run_on_mcp_loop,
                    discover_mcp_tools, register_mcp_servers) -> dict[str, Any]:
        target = str(req.get("server") or "").strip() or None

        config = self._read_mcp_config(profile)
        mcp_configs = config.get("mcp_servers", {}) or {} if config else {}
        profile_server_names = set(mcp_configs.keys())

        if target and target not in mcp_configs:
            return {"error": "server \'%s\' not found in config" % target, "ok": False}

        if target:
            self._shutdown_mcp_server(target, _servers, _lock, run_on_mcp_loop)
        else:
            self._shutdown_mcp_servers(list(profile_server_names), _servers, _lock, run_on_mcp_loop)

        # Run discovery in background to avoid blocking the request
        if target:
            def _reload_single():
                original = _apply_profile_env(profile)
                try:
                    server_config = {target: mcp_configs.get(target, {})}
                    register_mcp_servers(server_config)
                finally:
                    _restore_profile_env(original)
            self._run_mcp_discovery_bg(_reload_single, profile)
        else:
            self._run_mcp_discovery_bg(discover_mcp_tools, profile)

        return {"ok": True, "message": "MCP servers reloaded"}

    def _make_server_socket(self) -> socket.socket:
        return _make_listen_socket(self.endpoint)

    def _read_request(self, conn: socket.socket) -> dict[str, Any]:
        return _read_json_request(conn)

    def _write_response(self, conn: socket.socket, resp: dict[str, Any]) -> None:
        _write_json_response(conn, resp)

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
        restore_signals = _install_stop_signal_handlers(self._stop)
        _start_parent_process_watchdog(
            _positive_int(os.environ.get("HERMES_AGENT_BRIDGE_BROKER_PID")),
            self._stop,
            f"worker:{_worker_profile() or 'default'}",
        )
        try:
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
        finally:
            restore_signals()
            server.close()
            if self.endpoint.startswith("ipc://"):
                try:
                    Path(self.endpoint.removeprefix("ipc://")).unlink(missing_ok=True)
                except OSError:
                    pass


class WorkerProcess:
    STARTUP_TIMEOUT_SECONDS = 120
    REQUEST_TIMEOUT_SECONDS = 120

    def __init__(self, key: str, profile: str, endpoint: str, agent_root: str | None, hermes_home: str | None) -> None:
        self.key = key or profile or "default"
        self.profile = profile or "default"
        self.endpoint = endpoint
        self.agent_root = agent_root
        self.hermes_home = hermes_home
        self.process: subprocess.Popen[str] | None = None
        self.last_used_at = time.time()
        self._lock = threading.RLock()

    @property
    def running(self) -> bool:
        return self.process is not None and self.process.poll() is None

    @property
    def pid(self) -> int | None:
        return self.process.pid if self.process is not None else None

    def start(self) -> None:
        with self._lock:
            if self.running:
                return
            args = [
                sys.executable,
                str(Path(__file__).resolve()),
                "--endpoint",
                self.endpoint,
                "--worker-profile",
                self.profile,
            ]
            if self.agent_root:
                args.extend(["--agent-root", self.agent_root])
            if self.hermes_home:
                args.extend(["--hermes-home", self.hermes_home])

            env = {
                **os.environ,
                "HERMES_AGENT_BRIDGE_ENDPOINT": self.endpoint,
                "HERMES_AGENT_BRIDGE_WORKER_PROFILE": self.profile,
                "HERMES_AGENT_BRIDGE_BROKER_PID": str(os.getpid()),
            }
            self.process = subprocess.Popen(
                args,
                env=env,
                cwd=os.getcwd(),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
            )
            self._pipe_stderr()
            self._wait_ready()

    def _pipe_stderr(self) -> None:
        proc = self.process
        if proc is None or proc.stderr is None:
            return

        def run() -> None:
            assert proc.stderr is not None
            for line in proc.stderr:
                text = line.rstrip()
                if text:
                    print(f"[hermes-bridge-worker:{self.key}] {text}", file=sys.stderr, flush=True)

        threading.Thread(target=run, daemon=True, name=f"hermes-bridge-worker-stderr-{self.key}").start()

    def _wait_ready(self) -> None:
        proc = self.process
        if proc is None or proc.stdout is None:
            raise RuntimeError(f"profile worker {self.key} did not start")
        lines: queue.Queue[str | None] = queue.Queue()
        ready_event = threading.Event()

        def read_stdout() -> None:
            assert proc.stdout is not None
            try:
                for line in proc.stdout:
                    if ready_event.is_set():
                        text = line.rstrip()
                        if text:
                            print(f"[hermes-bridge-worker:{self.key}] {text}", file=sys.stderr, flush=True)
                    else:
                        lines.put(line)
            finally:
                lines.put(None)

        threading.Thread(target=read_stdout, daemon=True, name=f"hermes-bridge-worker-stdout-{self.key}").start()
        deadline = time.time() + self.STARTUP_TIMEOUT_SECONDS
        while time.time() < deadline:
            if proc.poll() is not None:
                raise RuntimeError(f"profile worker {self.key} exited before ready")
            try:
                line = lines.get(timeout=0.1)
            except queue.Empty:
                continue
            if line is None:
                time.sleep(0.05)
                continue
            text = line.strip()
            if text:
                print(f"[hermes-bridge-worker:{self.key}] {text}", file=sys.stderr, flush=True)
            try:
                data = json.loads(text)
                if data.get("event") == "ready":
                    ready_event.set()
                    return
            except Exception:
                pass
        self.stop()
        raise RuntimeError(f"profile worker {self.key} did not become ready within {self.STARTUP_TIMEOUT_SECONDS}s")

    def stop(self) -> None:
        with self._lock:
            proc = self.process
            self.process = None
        if proc is None:
            return
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=3)
        if self.endpoint.startswith("ipc://"):
            try:
                Path(self.endpoint.removeprefix("ipc://")).unlink(missing_ok=True)
            except OSError:
                pass

    def request(self, req: dict[str, Any], timeout: float | None = None) -> dict[str, Any]:
        self.start()
        self.last_used_at = time.time()
        request_timeout = timeout if timeout is not None and timeout > 0 else self.REQUEST_TIMEOUT_SECONDS
        return _send_bridge_request(self.endpoint, req, request_timeout)


def _worker_endpoint(key: str, namespace: str | None = None) -> str:
    namespace_key = f"{namespace or ''}\0{key}"
    safe = hashlib.sha256(namespace_key.encode("utf-8")).hexdigest()[:16]
    transport = os.environ.get("HERMES_AGENT_BRIDGE_WORKER_TRANSPORT", "").strip().lower()
    use_tcp = transport == "tcp" or (transport not in {"ipc", "unix"} and os.name == "nt")
    if use_tcp:
        port_base = int(os.environ.get("HERMES_AGENT_BRIDGE_WORKER_PORT_BASE", "18780"))
        return f"tcp://127.0.0.1:{port_base + int(safe[:4], 16) % 1000}"
    root = Path(tempfile.gettempdir()) / "hermes-agent-bridge-workers"
    return f"ipc://{root / f'{safe}.sock'}"


def _connect_bridge_socket(endpoint: str, timeout: float) -> socket.socket:
    if endpoint.startswith("ipc://"):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        sock.connect(endpoint.removeprefix("ipc://"))
        return sock
    parsed = urlparse(endpoint)
    if parsed.scheme != "tcp":
        raise RuntimeError(f"unsupported endpoint scheme: {endpoint}")
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    sock.connect((parsed.hostname or "127.0.0.1", int(parsed.port or 0)))
    return sock


def _send_bridge_request(endpoint: str, req: dict[str, Any], timeout: float) -> dict[str, Any]:
    sock = _connect_bridge_socket(endpoint, timeout)
    try:
        sock.sendall(_json_line_bytes(req))
        chunks: list[bytes] = []
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
            if b"\n" in chunk:
                break
        line = b"".join(chunks).split(b"\n", 1)[0].strip()
        if not line:
            raise RuntimeError("worker closed without a response")
        resp = json.loads(line.decode("utf-8"))
        if not resp.get("ok"):
            raise RuntimeError(str(resp.get("error") or "worker request failed"))
        return resp
    finally:
        try:
            sock.close()
        except OSError:
            pass


def _tcp_endpoint_port(endpoint: str) -> int | None:
    parsed = urlparse(endpoint)
    if parsed.scheme != "tcp":
        return None
    try:
        port = int(parsed.port or 0)
        return port if port > 0 else None
    except (TypeError, ValueError):
        return None


def _platform_text_encoding() -> str:
    getencoding = getattr(locale, "getencoding", None)
    if callable(getencoding):
        return getencoding() or "utf-8"
    return locale.getpreferredencoding(False) or "utf-8"


def _windows_listening_pids_on_port(port: int) -> list[int]:
    if os.name != "nt":
        return []
    try:
        result = subprocess.run(
            ["netstat.exe", "-ano", "-p", "tcp"],
            check=False,
            capture_output=True,
            text=True,
            encoding=_platform_text_encoding(),
            errors="ignore",
            timeout=5,
        )
    except Exception:
        return []
    stdout = result.stdout or ""
    pids: set[int] = set()
    for line in stdout.splitlines():
        parts = line.strip().split()
        if len(parts) < 5:
            continue
        proto, local_address, _remote_address, state, pid_raw = parts[:5]
        if proto.upper() != "TCP" or state.upper() != "LISTENING":
            continue
        if not local_address.endswith(f":{port}"):
            continue
        try:
            pid = int(pid_raw)
        except ValueError:
            continue
        if pid > 0 and pid != os.getpid():
            pids.add(pid)
    return sorted(pids)


def _kill_windows_endpoint_occupants(endpoint: str) -> None:
    if os.name != "nt":
        return
    port = _tcp_endpoint_port(endpoint)
    if not port:
        return
    for pid in _windows_listening_pids_on_port(port):
        try:
            print(
                f"[hermes-bridge] killing stale process tree pid={pid} port={port}",
                file=sys.stderr,
                flush=True,
            )
            subprocess.run(
                ["taskkill.exe", "/PID", str(pid), "/T", "/F"],
                check=False,
                capture_output=True,
                text=True,
                timeout=10,
            )
        except Exception as exc:
            print(
                f"[hermes-bridge] failed to kill stale process pid={pid}: {exc}",
                file=sys.stderr,
                flush=True,
            )
    deadline = time.time() + 3
    while time.time() < deadline:
        if not _windows_listening_pids_on_port(port):
            return
        time.sleep(0.1)


def _make_listen_socket(endpoint: str) -> socket.socket:
    _kill_windows_endpoint_occupants(endpoint)
    if endpoint.startswith("ipc://"):
        if not hasattr(socket, "AF_UNIX"):
            raise RuntimeError("ipc:// endpoints require Unix domain socket support; use tcp://host:port on this platform")
        sock_path = Path(endpoint.removeprefix("ipc://"))
        sock_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            sock_path.unlink(missing_ok=True)
        except OSError:
            pass
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(str(sock_path))
        return server

    parsed = urlparse(endpoint)
    if parsed.scheme != "tcp":
        raise RuntimeError(f"unsupported endpoint scheme: {endpoint}")
    host = parsed.hostname or "127.0.0.1"
    port = int(parsed.port or 0)
    if port <= 0:
        raise RuntimeError(f"tcp endpoint requires a port: {endpoint}")
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((host, port))
    return server


def _read_json_request(conn: socket.socket) -> dict[str, Any]:
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


def _write_json_response(conn: socket.socket, resp: dict[str, Any]) -> None:
    conn.sendall(_json_line_bytes(resp))


class BridgeBroker:
    IDLE_TIMEOUT_SECONDS = 30 * 60
    GC_INTERVAL_SECONDS = 60

    def __init__(self, endpoint: str, agent_root: str | None = None, hermes_home: str | None = None) -> None:
        self.endpoint = endpoint
        self.agent_root = agent_root
        self.hermes_home = hermes_home
        self._workers: dict[str, WorkerProcess] = {}
        self._run_profile: dict[str, str] = {}
        self._run_worker_key: dict[str, str] = {}
        self._running_run_profile: dict[str, str] = {}
        self._running_run_worker_key: dict[str, str] = {}
        self._session_profile: dict[str, str] = {}
        self._session_worker_key: dict[str, str] = {}
        self._approval_profile: dict[str, str] = {}
        self._approval_worker_key: dict[str, str] = {}
        self._clarify_profile: dict[str, str] = {}
        self._clarify_worker_key: dict[str, str] = {}
        self._compression_profile: dict[str, str] = {}
        self._compression_worker_key: dict[str, str] = {}
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._last_gc = time.time()

    def _normalize_profile(self, value: Any) -> str:
        profile = str(value or "").strip()
        return profile or "default"

    def _normalize_worker_key(self, profile: str, value: Any = None) -> str:
        worker_key = str(value or "").strip()
        return worker_key or profile

    def _worker_for_profile(self, profile: str, worker_key: str | None = None) -> WorkerProcess:
        profile = self._normalize_profile(profile)
        key = self._normalize_worker_key(profile, worker_key)
        with self._lock:
            worker = self._workers.get(key)
            if worker is None:
                worker = WorkerProcess(key, profile, _worker_endpoint(key, self.endpoint), self.agent_root, self.hermes_home)
                self._workers[key] = worker
        return worker

    def _route_for_run(self, run_id: str) -> tuple[str, str | None]:
        with self._lock:
            profile = self._run_profile.get(run_id)
            worker_key = self._run_worker_key.get(run_id)
        if not profile:
            raise KeyError(f"unknown run: {run_id}")
        return profile, worker_key

    def _route_for_session(self, session_id: str, fallback_profile: Any = None, worker_key: Any = None) -> tuple[str, str | None]:
        with self._lock:
            profile = self._session_profile.get(session_id)
            stored_worker_key = self._session_worker_key.get(session_id)
        if not profile:
            fallback = self._normalize_profile(fallback_profile)
            if fallback_profile is not None and fallback:
                return fallback, self._normalize_worker_key(fallback, worker_key)
            raise KeyError(f"unknown session: {session_id}")
        return profile, self._normalize_worker_key(profile, worker_key) if worker_key is not None else stored_worker_key

    def _record_response_routes(self, profile: str, worker_key: str, resp: dict[str, Any]) -> None:
        run_id = str(resp.get("run_id") or "")
        session_id = str(resp.get("session_id") or "")
        with self._lock:
            if run_id:
                self._run_profile[run_id] = profile
                self._run_worker_key[run_id] = worker_key
                if resp.get("status") == "running":
                    self._running_run_profile[run_id] = profile
                    self._running_run_worker_key[run_id] = worker_key
                else:
                    self._running_run_profile.pop(run_id, None)
                    self._running_run_worker_key.pop(run_id, None)
            if session_id:
                self._session_profile[session_id] = profile
                self._session_worker_key[session_id] = worker_key
            for event in resp.get("events") or []:
                if not isinstance(event, dict):
                    continue
                approval_id = str(event.get("approval_id") or "")
                if approval_id:
                    self._approval_profile[approval_id] = profile
                    self._approval_worker_key[approval_id] = worker_key
                clarify_id = str(event.get("clarify_id") or "")
                if clarify_id:
                    self._clarify_profile[clarify_id] = profile
                    self._clarify_worker_key[clarify_id] = worker_key
                request_id = str(event.get("request_id") or "")
                if event.get("event") == "bridge.compression.requested" and request_id:
                    self._compression_profile[request_id] = profile
                    self._compression_worker_key[request_id] = worker_key
                if event.get("event") in {"bridge.compression.completed", "bridge.compression.failed"} and request_id:
                    self._compression_profile.pop(request_id, None)
                    self._compression_worker_key.pop(request_id, None)

    def stop(self) -> None:
        self._stop.set()
        with self._lock:
            workers = list(self._workers.values())
            self._workers.clear()
            self._run_profile.clear()
            self._run_worker_key.clear()
            self._running_run_profile.clear()
            self._running_run_worker_key.clear()
            self._session_profile.clear()
            self._session_worker_key.clear()
            self._approval_profile.clear()
            self._approval_worker_key.clear()
            self._clarify_profile.clear()
            self._clarify_worker_key.clear()
            self._compression_profile.clear()
            self._compression_worker_key.clear()
        for worker in workers:
            worker.stop()

    def _forward(self, profile: str, req: dict[str, Any], worker_key: str | None = None) -> dict[str, Any]:
        profile = self._normalize_profile(profile)
        key = self._normalize_worker_key(profile, worker_key)
        worker = self._worker_for_profile(profile, key)
        forwarded = dict(req)
        forwarded["profile"] = profile
        forwarded.pop("worker_key", None)
        try:
            resp = worker.request(forwarded, self._worker_request_timeout(req))
            self._record_response_routes(profile, key, resp)
            return resp
        except RuntimeError as e:
            # Worker returned ok=false or connection error — return error response
            return {"ok": False, "error": str(e)}

    def _worker_request_timeout(self, req: dict[str, Any]) -> float:
        try:
            timeout = float(req.get("timeout", 0) or 0)
        except (TypeError, ValueError):
            timeout = 0
        if timeout <= 0:
            return WorkerProcess.REQUEST_TIMEOUT_SECONDS
        return max(WorkerProcess.REQUEST_TIMEOUT_SECONDS, timeout + 10)

    def handle(self, req: dict[str, Any]) -> dict[str, Any]:
        action = str(req.get("action") or "").strip()
        if not action:
            raise ValueError("action is required")

        if action == "ping":
            with self._lock:
                worker_details = {
                    key: {
                        "running": worker.running,
                        "pid": worker.pid,
                        "endpoint": worker.endpoint,
                        "profile": getattr(worker, "profile", key),
                        "last_used_at": worker.last_used_at,
                    }
                    for key, worker in self._workers.items()
                }
                workers = {key: details["running"] for key, details in worker_details.items()}
                sessions_by_profile: dict[str, int] = {}
                for profile in self._session_profile.values():
                    sessions_by_profile[profile] = sessions_by_profile.get(profile, 0) + 1
                running_sessions_by_profile: dict[str, int] = {}
                for profile in self._running_run_profile.values():
                    running_sessions_by_profile[profile] = running_sessions_by_profile.get(profile, 0) + 1
                active_sessions = len(self._session_profile)
                running_sessions = len(self._running_run_profile)
            return {
                "pong": True,
                "time": time.time(),
                "mode": "broker",
                "broker": {
                    "pid": os.getpid(),
                    "endpoint": self.endpoint,
                },
                "workers": workers,
                "worker_details": worker_details,
                "active_sessions": active_sessions,
                "running_sessions": running_sessions,
                "sessions_by_profile": sessions_by_profile,
                "running_sessions_by_profile": running_sessions_by_profile,
            }

        if action == "worker_ping":
            profile = self._normalize_profile(req.get("profile"))
            worker_key = self._normalize_worker_key(profile, req.get("worker_key"))
            resp = self._forward(profile, {"action": "ping"}, worker_key)
            resp["worker_profile"] = profile
            resp["worker_key"] = worker_key
            return resp

        if action == "chat":
            profile = self._normalize_profile(req.get("profile"))
            return self._forward(profile, req, self._normalize_worker_key(profile, req.get("worker_key")))

        if action == "context_estimate":
            profile = self._normalize_profile(req.get("profile"))
            return self._forward(profile, req, self._normalize_worker_key(profile, req.get("worker_key")))

        if action in {"get_result", "get_output"}:
            profile, worker_key = self._route_for_run(str(req.get("run_id") or ""))
            return self._forward(profile, req, worker_key)

        if action in {"interrupt", "steer", "command", "goal_evaluate", "goal_pause", "status", "get_history", "destroy"}:
            session_id = str(req.get("session_id") or "")
            profile, worker_key = self._route_for_session(session_id, req.get("profile"), req.get("worker_key") if "worker_key" in req else None)
            resp = self._forward(profile, req, worker_key)
            if action == "destroy":
                with self._lock:
                    self._session_profile.pop(session_id, None)
                    self._session_worker_key.pop(session_id, None)
            return resp

        if action == "approval_respond":
            approval_id = str(req.get("approval_id") or "").strip()
            if not approval_id:
                raise ValueError("approval_id is required")
            with self._lock:
                profile = self._approval_profile.get(approval_id)
                worker_key = self._approval_worker_key.get(approval_id)
            if not profile:
                raise KeyError(f"unknown approval request: {approval_id}")
            return self._forward(profile, req, worker_key)

        if action == "clarify_respond":
            clarify_id = str(req.get("clarify_id") or "").strip()
            if not clarify_id:
                raise ValueError("clarify_id is required")
            with self._lock:
                profile = self._clarify_profile.get(clarify_id)
                worker_key = self._clarify_worker_key.get(clarify_id)
            if not profile:
                raise KeyError(f"unknown clarify request: {clarify_id}")
            return self._forward(profile, req, worker_key)

        if action == "compression_respond":
            request_id = str(req.get("request_id") or "").strip()
            if not request_id:
                raise ValueError("request_id is required")
            with self._lock:
                profile = self._compression_profile.get(request_id)
                worker_key = self._compression_worker_key.get(request_id)
            if not profile:
                raise KeyError(f"unknown compression request: {request_id}")
            return self._forward(profile, req, worker_key)

        if action == "destroy_all":
            with self._lock:
                workers = list(self._workers.values())
                self._workers.clear()
                self._run_profile.clear()
                self._run_worker_key.clear()
                self._running_run_profile.clear()
                self._running_run_worker_key.clear()
                self._session_profile.clear()
                self._session_worker_key.clear()
                self._approval_profile.clear()
                self._approval_worker_key.clear()
                self._clarify_profile.clear()
                self._clarify_worker_key.clear()
                self._compression_profile.clear()
                self._compression_worker_key.clear()
            destroyed = 0
            for worker in workers:
                try:
                    if worker.running:
                        resp = worker.request({"action": "destroy_all"})
                        destroyed += int(resp.get("destroyed") or 0)
                except Exception:
                    pass
                finally:
                    worker.stop()
            return {"destroyed": destroyed}

        if action == "destroy_profile":
            profile = self._normalize_profile(req.get("profile"))
            with self._lock:
                workers = [
                    worker
                    for key, worker in list(self._workers.items())
                    if getattr(worker, "profile", key) == profile
                ]
                for worker in workers:
                    self._workers.pop(worker.key, None)
                self._run_profile = {key: value for key, value in self._run_profile.items() if value != profile}
                self._run_worker_key = {key: value for key, value in self._run_worker_key.items() if key in self._run_profile}
                self._running_run_profile = {key: value for key, value in self._running_run_profile.items() if value != profile}
                self._running_run_worker_key = {key: value for key, value in self._running_run_worker_key.items() if key in self._running_run_profile}
                self._session_profile = {key: value for key, value in self._session_profile.items() if value != profile}
                self._session_worker_key = {key: value for key, value in self._session_worker_key.items() if key in self._session_profile}
                self._approval_profile = {key: value for key, value in self._approval_profile.items() if value != profile}
                self._approval_worker_key = {key: value for key, value in self._approval_worker_key.items() if key in self._approval_profile}
                self._clarify_profile = {key: value for key, value in self._clarify_profile.items() if value != profile}
                self._clarify_worker_key = {key: value for key, value in self._clarify_worker_key.items() if key in self._clarify_profile}
                self._compression_profile = {key: value for key, value in self._compression_profile.items() if value != profile}
                self._compression_worker_key = {key: value for key, value in self._compression_worker_key.items() if key in self._compression_profile}

            if not workers:
                return {"profile": profile, "destroyed": 0}

            destroyed = 0
            for worker in workers:
                if not worker.running:
                    worker.stop()
                    continue
                try:
                    resp = worker.request({"action": "destroy_all"})
                    destroyed += int(resp.get("destroyed") or 0)
                except Exception:
                    pass
                finally:
                    worker.stop()
            return {"profile": profile, "destroyed": destroyed}

        if action == "list":
            sessions: list[Any] = []
            with self._lock:
                workers = list(self._workers.items())
            for key, worker in workers:
                if not worker.running:
                    continue
                try:
                    resp = worker.request({"action": "list"})
                    for session in resp.get("sessions") or []:
                        if isinstance(session, dict):
                            session.setdefault("profile", getattr(worker, "profile", key))
                            session.setdefault("worker_key", key)
                        sessions.append(session)
                except Exception:
                    pass
            return {"sessions": sessions}

        if action == "shutdown":
            self.stop()
            return {"status": "shutting_down"}

        # ───── MCP Management ─────
        if action.startswith("mcp_"):
            profile = self._normalize_profile(req.get("profile"))
            return self._forward(profile, req)

        raise ValueError(f"unknown action: {action}")

    def _make_server_socket(self) -> socket.socket:
        return _make_listen_socket(self.endpoint)

    def _read_request(self, conn: socket.socket) -> dict[str, Any]:
        return _read_json_request(conn)

    def _write_response(self, conn: socket.socket, resp: dict[str, Any]) -> None:
        _write_json_response(conn, resp)

    def _handle_connection(self, conn: socket.socket) -> None:
        try:
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
        except Exception as exc:
            print(f"[hermes-bridge-broker] connection error: {exc}", file=sys.stderr, flush=True)
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def _gc_idle_workers(self) -> None:
        now = time.time()
        if now - self._last_gc < self.GC_INTERVAL_SECONDS:
            return
        self._last_gc = now
        with self._lock:
            idle = [
                key for key, worker in self._workers.items()
                if worker.running and now - worker.last_used_at > self.IDLE_TIMEOUT_SECONDS
            ]
        for key in idle:
            with self._lock:
                worker = self._workers.pop(key, None)
            if worker:
                worker.stop()

    def serve_forever(self) -> None:
        server = self._make_server_socket()
        restore_signals = _install_stop_signal_handlers(self._stop)
        atexit.register(self.stop)
        try:
            server.listen(64)
            server.settimeout(0.2)
            print(json.dumps({"event": "ready", "endpoint": self.endpoint, "mode": "broker"}), flush=True)

            while not self._stop.is_set():
                try:
                    try:
                        conn, _addr = server.accept()
                    except socket.timeout:
                        self._gc_idle_workers()
                        continue
                    threading.Thread(
                        target=self._handle_connection,
                        args=(conn,),
                        daemon=True,
                        name="hermes-bridge-broker-connection",
                    ).start()
                except KeyboardInterrupt:
                    break
                except Exception as exc:
                    print(f"[hermes-bridge-broker] server loop error: {exc}", file=sys.stderr, flush=True)
        finally:
            restore_signals()
            try:
                atexit.unregister(self.stop)
            except Exception:
                pass
            self.stop()
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
    parser.add_argument("--worker-profile", default=os.environ.get("HERMES_AGENT_BRIDGE_WORKER_PROFILE"))
    args = parser.parse_args(argv)

    _set_path_env(args.agent_root, args.hermes_home)
    _ensure_agent_imports()
    if args.worker_profile:
        _set_worker_profile_env(str(args.worker_profile or "default"))
        _log_worker_startup_context(str(args.worker_profile or "default"))
        BridgeServer(args.endpoint).serve_forever()
    else:
        BridgeBroker(args.endpoint, args.agent_root, args.hermes_home).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
