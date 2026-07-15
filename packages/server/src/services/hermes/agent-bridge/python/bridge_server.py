from __future__ import annotations

import hashlib
import json
import math
import os
import re
import socket
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlsplit

from bridge_pool import AgentPool
from bridge_runtime import (
    _agent_root,
    _apply_profile_env,
    _hermes_home,
    _install_stop_signal_handlers,
    _jsonable,
    _positive_int,
    _profile_env,
    _profile_home,
    _restore_profile_env,
    _start_parent_process_watchdog,
    _worker_profile,
)
from bridge_transport import _make_listen_socket, _read_json_request, _write_json_response

class BridgeServer:
    IDLE_TIMEOUT_SECONDS = 30 * 60  # 30 minutes
    GC_INTERVAL_SECONDS = 60  # check every minute

    def __init__(self, endpoint: str) -> None:
        self.endpoint = endpoint
        self.pool = AgentPool()
        self._stop = threading.Event()
        self._last_gc = time.time()
        self._fabric_browser_lock = threading.RLock()
        self._fabric_browser_sessions: dict[str, dict[str, str]] = {}

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
            workspace = req.get("workspace")
            source = req.get("source")
            # Local patch (reasoning-effort): per-session reasoning effort override (Web UI brain button).
            reasoning_effort = req.get("reasoning_effort")
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
                workspace,
                source,
                reasoning_effort,
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
                workspace=req.get("workspace"),
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

        if action == "get_session_title":
            return self.pool.get_session_title(
                str(req.get("session_id") or ""),
                req.get("profile"),
            )

        if action == "command":
            session_id = str(req.get("session_id") or "").strip()
            if not session_id:
                raise ValueError("session_id is required")
            return self.pool.dispatch_command(
                session_id,
                str(req.get("command") or ""),
                req.get("profile"),
            )

        if action == "skills_reload":
            return self._reload_skills(req.get("profile"))

        if action == "switch_session_model":
            session_id = str(req.get("session_id") or "").strip()
            if not session_id:
                raise ValueError("session_id is required")
            model = str(req.get("model") or "").strip()
            if not model:
                raise ValueError("model is required")
            return self.pool.switch_session_model(
                session_id,
                model,
                str(req.get("provider") or "").strip(),
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
            self._shutdown_all_mcp_servers()
            self._stop.set()
            return {"status": "shutting_down"}

        # ───── MCP Management (forwarded from broker) ─────
        if action.startswith("mcp_"):
            return self._handle_mcp_action(action, req, req.get("profile"))

        # Server-internal browser execution is intentionally narrower than
        # the chat browser tool surface. Route every browser-prefixed action
        # through the deny-by-default handler so click/type/evaluate/download
        # primitives receive a stable security error.
        if action.startswith("browser_"):
            return self._handle_browser_action(action, req, req.get("profile"))

        raise ValueError(f"unknown action: {action}")

    # ───── Governed Browser Execution (for Action Fabric only) ─────

    _BROWSER_WORKFLOW_ID = re.compile(r"^workflow-[A-Za-z0-9._:-]{1,190}$")
    _BROWSER_SEARCH_ORDERS = {"totalrank", "pubdate", "click"}
    _BROWSER_CHALLENGE_TEXT = re.compile(
        r"captcha|are you (?:a )?robot|robot verification|human verification|"
        r"verification required|please verify|cloudflare|checking your browser|"
        r"just a moment|attention required|\u4eba\u673a\u9a8c\u8bc1|\u5b89\u5168\u9a8c\u8bc1|\u8bf7\u5b8c\u6210\u9a8c\u8bc1|\u6ed1\u5757\u9a8c\u8bc1",
        re.IGNORECASE,
    )
    _BROWSER_LOGIN_TEXT = re.compile(
        r"login required|sign in to continue|please log in to continue|"
        r"\u8bf7\u5148\u767b\u5f55|\u767b\u5f55\u540e(?:\u624d\u53ef|\u53ef\u4ee5|\u67e5\u770b|\u7ee7\u7eed)|\u626b\u7801\u767b\u5f55",
        re.IGNORECASE,
    )
    _BROWSER_CONSENT_TEXT = re.compile(
        r"consent required|accept cookies to continue|privacy choices required|"
        r"\u8bf7\u540c\u610f(?:\u9690\u79c1|\u7528\u6237)\u534f\u8bae|\u540c\u610f\u540e\u7ee7\u7eed",
        re.IGNORECASE,
    )

    @classmethod
    def _browser_error(cls, code: str) -> dict[str, Any]:
        return {"ok": False, "error": "Browser call rejected", "error_code": code}

    @classmethod
    def _browser_result_error(cls, action: str, workflow_id: str, session_id: str,
                              code: str, status: str = "error") -> dict[str, Any]:
        return {
            "ok": True,
            "action": action,
            "workflow_id": workflow_id,
            "session_id": session_id,
            "status": status,
            "error_code": code,
        }

    @classmethod
    def _validate_browser_url(cls, value: Any) -> str | None:
        if not isinstance(value, str) or not value or len(value) > 2048 or cls._MCP_SENSITIVE_TEXT.search(value):
            return None
        try:
            parsed = urlsplit(value)
            if parsed.scheme.lower() != "https" or parsed.fragment or parsed.username or parsed.password or parsed.port is not None:
                return None
        except (TypeError, ValueError):
            return None

        host = (parsed.hostname or "").lower()
        if host == "www.bilibili.com":
            match = re.fullmatch(r"/video/(BV[0-9A-Za-z]{10})/?", parsed.path)
            if match is None or parsed.query:
                return None
            return f"https://www.bilibili.com/video/{match.group(1)}"

        if host != "search.bilibili.com" or parsed.path != "/all":
            return None
        try:
            pairs = parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=True)
        except ValueError:
            return None
        if len(pairs) != 3 or {key for key, _value in pairs} != {"keyword", "order", "page"}:
            return None
        values = {key: item for key, item in pairs}
        keyword = values.get("keyword", "").strip()
        if not keyword or len(keyword) > 120 or cls._MCP_SENSITIVE_TEXT.search(keyword):
            return None
        if values.get("order") not in cls._BROWSER_SEARCH_ORDERS:
            return None
        try:
            page = int(values.get("page", ""))
        except ValueError:
            return None
        if str(page) != values.get("page") or page < 1 or page > 10:
            return None
        return value

    @staticmethod
    def _browser_session_identity(profile: str, workflow_id: str) -> tuple[str, str]:
        digest = hashlib.sha256(f"{profile}:{workflow_id}".encode("utf-8")).hexdigest()
        return f"fabric_browser_{digest[:32]}", f"browser-session-{digest[:24]}"

    def _handle_browser_action(self, action: str, req: dict[str, Any], profile: str | None = None) -> dict[str, Any]:
        if action not in {"browser_navigate", "browser_snapshot"}:
            return self._browser_error("BROWSER_ACTION_FORBIDDEN")

        allowed_keys = {"action", "profile", "workflow_id", "timeout"}
        if action == "browser_navigate":
            allowed_keys.add("url")
        if set(req) - allowed_keys:
            return self._browser_error("BROWSER_REQUEST_INVALID")

        worker_profile = _worker_profile() or "default"
        if profile != worker_profile:
            return self._browser_error("BROWSER_PROFILE_MISMATCH")
        workflow_id = str(req.get("workflow_id") or "").strip()
        if not self._BROWSER_WORKFLOW_ID.fullmatch(workflow_id):
            return self._browser_error("BROWSER_WORKFLOW_INVALID")
        try:
            timeout = float(req.get("timeout") or 30)
        except (TypeError, ValueError):
            return self._browser_error("BROWSER_TIMEOUT_INVALID")
        if not math.isfinite(timeout) or timeout < 5 or timeout > 60 or not timeout.is_integer():
            return self._browser_error("BROWSER_TIMEOUT_INVALID")
        timeout_seconds = int(timeout)

        try:
            from tools.browser_tool import _run_browser_command, cleanup_browser
        except ImportError:
            return self._browser_error("BROWSER_EXECUTION_UNAVAILABLE")

        task_id, session_id = self._browser_session_identity(profile, workflow_id)
        if action == "browser_navigate":
            url = self._validate_browser_url(req.get("url"))
            if url is None:
                return self._browser_error("BROWSER_URL_REJECTED")
            try:
                raw = _run_browser_command(task_id, "open", [url], timeout=timeout_seconds)
            except Exception:
                return self._browser_result_error("navigate", workflow_id, session_id, "BROWSER_NAVIGATION_FAILED")
            if not isinstance(raw, dict) or raw.get("success") is not True or not isinstance(raw.get("data"), dict):
                return self._browser_result_error("navigate", workflow_id, session_id, "BROWSER_NAVIGATION_FAILED")
            data = raw["data"]
            final_url = self._validate_browser_url(data.get("url", url))
            if final_url is None:
                try:
                    cleanup_browser(task_id)
                except Exception:
                    pass
                with self._fabric_browser_lock:
                    self._fabric_browser_sessions.pop(task_id, None)
                return self._browser_error("BROWSER_REDIRECT_REJECTED")
            title = data.get("title", "")
            if not isinstance(title, str) or len(title) > 512 or self._MCP_SENSITIVE_TEXT.search(title):
                return self._browser_result_error("navigate", workflow_id, session_id, "BROWSER_RESULT_INVALID")
            with self._fabric_browser_lock:
                self._fabric_browser_sessions[task_id] = {
                    "profile": profile,
                    "workflow_id": workflow_id,
                    "url": final_url,
                }
            return {
                "ok": True,
                "action": "navigate",
                "workflow_id": workflow_id,
                "session_id": session_id,
                "status": "succeeded",
                "error_code": None,
                "url": final_url,
                "title": title,
            }

        with self._fabric_browser_lock:
            state = self._fabric_browser_sessions.get(task_id)
        if not state or state.get("profile") != profile or state.get("workflow_id") != workflow_id:
            return self._browser_result_error("snapshot", workflow_id, session_id, "BROWSER_SESSION_REOPEN_REQUIRED")
        try:
            raw = _run_browser_command(task_id, "snapshot", ["-c"], timeout=timeout_seconds)
        except Exception:
            return self._browser_result_error("snapshot", workflow_id, session_id, "BROWSER_SNAPSHOT_FAILED")
        if not isinstance(raw, dict) or raw.get("success") is not True or not isinstance(raw.get("data"), dict):
            return self._browser_result_error("snapshot", workflow_id, session_id, "BROWSER_SNAPSHOT_FAILED")
        data = raw["data"]
        snapshot = data.get("snapshot")
        refs = data.get("refs", {})
        if not isinstance(snapshot, str) or len(snapshot.encode("utf-8")) > 65_536:
            return self._browser_result_error("snapshot", workflow_id, session_id, "BROWSER_RESULT_INVALID")
        if self._BROWSER_CHALLENGE_TEXT.search(snapshot):
            return self._browser_result_error(
                "snapshot", workflow_id, session_id, "BROWSER_HUMAN_VERIFICATION_REQUIRED", "waiting_user")
        if self._BROWSER_LOGIN_TEXT.search(snapshot):
            return self._browser_result_error(
                "snapshot", workflow_id, session_id, "BROWSER_LOGIN_REQUIRED", "waiting_user")
        if self._BROWSER_CONSENT_TEXT.search(snapshot):
            return self._browser_result_error(
                "snapshot", workflow_id, session_id, "BROWSER_CONSENT_REQUIRED", "waiting_user")
        if self._MCP_SENSITIVE_TEXT.search(snapshot):
            return self._browser_result_error("snapshot", workflow_id, session_id, "BROWSER_RESULT_INVALID")
        element_count = len(refs) if isinstance(refs, dict) else 0
        return {
            "ok": True,
            "action": "snapshot",
            "workflow_id": workflow_id,
            "session_id": session_id,
            "status": "succeeded",
            "error_code": None,
            "url": state["url"],
            "snapshot": snapshot,
            "element_count": min(element_count, 100_000),
        }

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

    def _shutdown_all_mcp_servers(self) -> int:
        try:
            from tools.mcp_tool import _run_on_mcp_loop, _servers, _lock
        except ImportError:
            return 0
        with _lock:
            names = list(_servers.keys())
        return self._shutdown_mcp_servers(names, _servers, _lock, _run_on_mcp_loop)

    def _handle_mcp_action(self, action: str, req: dict[str, Any], profile: str | None = None) -> dict[str, Any]:
        """Handle MCP management actions in worker process."""
        try:
            from tools.mcp_tool import discover_mcp_tools, register_mcp_servers, _run_on_mcp_loop, _servers, _lock
        except ImportError:
            return {"error": "MCP tool module not available", "ok": False}

        try:
            from tools.mcp_tool import sanitize_mcp_name_component, _make_tool_handler
        except ImportError:
            sanitize_mcp_name_component = None
            _make_tool_handler = None

        if profile is None:
            profile = _worker_profile() or "default"

        dispatch = {
            "mcp_list":            lambda: self._mcp_list(profile, _servers, _lock),
            "mcp_server_add":      lambda: self._mcp_server_add(req, profile, discover_mcp_tools),
            "mcp_server_update":   lambda: self._mcp_server_update(req, profile, _servers, _lock, _run_on_mcp_loop, discover_mcp_tools),
            "mcp_server_remove":   lambda: self._mcp_server_remove(req, profile, _servers, _lock, _run_on_mcp_loop),
            "mcp_server_test":     lambda: self._mcp_server_test(req, _servers, _lock),
            "mcp_tools_list":      lambda: self._mcp_tools_list(req, profile, _servers, _lock),
            "mcp_tool_call":       lambda: self._mcp_call_error("MCP_EXECUTION_UNAVAILABLE")
            if _make_tool_handler is None or sanitize_mcp_name_component is None else self._mcp_tool_call(
                req, profile, _servers, _lock, _make_tool_handler, sanitize_mcp_name_component),
            "mcp_reload":          lambda: self._mcp_reload(req, profile, _servers, _lock, _run_on_mcp_loop, discover_mcp_tools, register_mcp_servers),
        }
        handler = dispatch.get(action)
        if handler:
            return handler()
        return {"error": f"unknown MCP action: {action}", "ok": False}

    def _reload_skills(self, profile: str | None = None) -> dict[str, Any]:
        resolved_profile = profile or _worker_profile() or "default"
        with _profile_env(resolved_profile):
            from agent.skill_commands import reload_skills

            result = reload_skills()
        return {
            "ok": True,
            "action": "reload-skills",
            **_jsonable(result),
        }

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
            tools_filter = srv_cfg.get("tools") if isinstance(srv_cfg.get("tools"), dict) else {}
            has_include_filter = "include" in tools_filter
            has_exclude_filter = "exclude" in tools_filter
            include_set = set(tools_filter.get("include") or [])
            exclude_set = set(tools_filter.get("exclude") or [])
            tool_details = []
            try:
                for mcp_tool in getattr(task, "_tools", []):
                    tname = getattr(mcp_tool, "name", "?")
                    if has_include_filter and tname not in include_set:
                        continue
                    if has_exclude_filter and tname in exclude_set:
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
        raw_mode = bool(req.get("raw"))  # Return unfiltered tools for visibility management
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
            tools_filter = srv_cfg.get("tools") if isinstance(srv_cfg.get("tools"), dict) else {}
            has_include_filter = "include" in tools_filter
            has_exclude_filter = "exclude" in tools_filter
            include_set = set(tools_filter.get("include") or [])
            exclude_set = set(tools_filter.get("exclude") or [])
            def _should_include(tn):
                if raw_mode:
                    return True  # Skip filter in raw mode
                if has_include_filter:
                    return tn in include_set
                if has_exclude_filter:
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

    _MCP_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$")
    _MCP_SENSITIVE_KEY = re.compile(
        r"^(?:auth|authentication|authorization|bearer|cookie|credentials?|password|passphrase|secret|token|"
        r"api[_-]?key|private[_-]?key|headers?|environment|env|path|file|directory)$|(?:^|[_-])(?:token|secret|password|cookie)$",
        re.IGNORECASE,
    )
    _MCP_SENSITIVE_TEXT = re.compile(
        r"(?:\bBearer\s+\S+|\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{12,}|"
        r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}|"
        r"\b(?:api[_ -]?key|access[_ -]?token|password|secret|credential)\s*[:=]\s*\S+|"
        r"-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----|"
        r"(?:^|[\s(\"'=])(?:[a-z]:[\\/]|\\\\|/(?:etc|home|Users|usr|app|workspace|data|var|tmp|opt|root|mnt)/)|"
        r"\bMEDIA:\s*\S+)",
        re.IGNORECASE,
    )

    @classmethod
    def _bounded_mcp_json(cls, value: Any, *, maximum_bytes: int, maximum_string: int) -> Any:
        nodes = 0

        def visit(item: Any, depth: int) -> Any:
            nonlocal nodes
            nodes += 1
            if nodes > 2048 or depth > 8:
                raise ValueError("MCP JSON exceeds structural bounds")
            if item is None or isinstance(item, bool):
                return item
            if isinstance(item, int):
                if abs(item) > 9_007_199_254_740_991:
                    raise ValueError("MCP JSON integer is outside the safe range")
                return item
            if isinstance(item, float):
                if not math.isfinite(item):
                    raise ValueError("MCP JSON number must be finite")
                return item
            if isinstance(item, str):
                if len(item) > maximum_string or cls._MCP_SENSITIVE_TEXT.search(item):
                    raise ValueError("MCP JSON contains sensitive or oversized text")
                return item
            if isinstance(item, list):
                if len(item) > 128:
                    raise ValueError("MCP JSON array is too large")
                return [visit(child, depth + 1) for child in item]
            if isinstance(item, dict):
                if len(item) > 128:
                    raise ValueError("MCP JSON object is too large")
                result = {}
                for key, child in item.items():
                    if not isinstance(key, str) or not key or len(key) > 160 or cls._MCP_SENSITIVE_KEY.search(key):
                        raise ValueError("MCP JSON contains an unsafe key")
                    result[key] = visit(child, depth + 1)
                return result
            raise ValueError("MCP JSON must contain only plain JSON values")

        sanitized = visit(value, 0)
        encoded = json.dumps(sanitized, ensure_ascii=False, separators=(",", ":"))
        if len(encoded.encode("utf-8")) > maximum_bytes:
            raise ValueError("MCP JSON exceeds its byte limit")
        return sanitized

    @classmethod
    def _mcp_call_error(cls, code: str) -> dict[str, Any]:
        return {"ok": False, "error": "MCP tool call rejected", "error_code": code}

    def _mcp_tool_call(self, req: dict, profile: str, _servers, _lock,
                       make_tool_handler, sanitize_name) -> dict[str, Any]:
        worker_profile = _worker_profile() or "default"
        if profile != worker_profile:
            return self._mcp_call_error("MCP_PROFILE_MISMATCH")

        server_name = str(req.get("server") or "").strip()
        tool_name = str(req.get("tool") or "").strip()
        if not self._MCP_IDENTIFIER.fullmatch(server_name) or not self._MCP_IDENTIFIER.fullmatch(tool_name):
            return self._mcp_call_error("MCP_IDENTITY_INVALID")

        arguments = req.get("arguments", {})
        if not isinstance(arguments, dict):
            return self._mcp_call_error("MCP_ARGUMENTS_INVALID")
        try:
            arguments = self._bounded_mcp_json(arguments, maximum_bytes=32_768, maximum_string=4_096)
        except Exception:
            return self._mcp_call_error("MCP_ARGUMENTS_INVALID")

        try:
            timeout = float(req.get("timeout") or 30)
        except (TypeError, ValueError):
            return self._mcp_call_error("MCP_TIMEOUT_INVALID")
        if not math.isfinite(timeout) or timeout < 1 or timeout > 60:
            return self._mcp_call_error("MCP_TIMEOUT_INVALID")

        config = self._read_mcp_config(profile)
        mcp_configs = config.get("mcp_servers", {}) if isinstance(config, dict) else {}
        if not isinstance(mcp_configs, dict) or server_name not in mcp_configs:
            return self._mcp_call_error("MCP_SERVER_NOT_CONFIGURED")
        server_config = mcp_configs.get(server_name)
        if not isinstance(server_config, dict) or server_config.get("enabled") is False:
            return self._mcp_call_error("MCP_SERVER_DISABLED")

        tools_filter = server_config.get("tools") if isinstance(server_config.get("tools"), dict) else {}
        include_active = "include" in tools_filter
        exclude_active = "exclude" in tools_filter
        include = tools_filter.get("include")
        exclude = tools_filter.get("exclude")
        include_names = {str(item) for item in include} if isinstance(include, list) else ({include} if isinstance(include, str) else set())
        exclude_names = {str(item) for item in exclude} if isinstance(exclude, list) else ({exclude} if isinstance(exclude, str) else set())
        if (include_active and tool_name not in include_names) or (not include_active and exclude_active and tool_name in exclude_names):
            return self._mcp_call_error("MCP_TOOL_FILTERED")

        with _lock:
            task = _servers.get(server_name)
        if task is None or getattr(task, "session", None) is None:
            return self._mcp_call_error("MCP_SERVER_UNAVAILABLE")
        runtime_tool = None
        for candidate in list(getattr(task, "_tools", []) or []):
            if getattr(candidate, "name", None) == tool_name:
                runtime_tool = candidate
                break
        if runtime_tool is None:
            return self._mcp_call_error("MCP_TOOL_UNAVAILABLE")
        registered = set(getattr(task, "_registered_tool_names", None) or [])
        prefixed_name = f"mcp_{sanitize_name(server_name)}_{sanitize_name(tool_name)}"
        if prefixed_name not in registered:
            return self._mcp_call_error("MCP_TOOL_NOT_REGISTERED")

        try:
            raw = make_tool_handler(server_name, tool_name, timeout)(arguments)
            if not isinstance(raw, str) or len(raw.encode("utf-8")) > 262_144:
                return self._mcp_call_error("MCP_RESULT_INVALID")
            parsed = json.loads(raw)
            if not isinstance(parsed, dict):
                return self._mcp_call_error("MCP_RESULT_INVALID")
            if "error" in parsed:
                return {"ok": True, "server": server_name, "tool": tool_name,
                        "status": "error", "error_code": "MCP_TOOL_FAILED", "result": None}
            result = parsed.get("structuredContent")
            if result is None:
                result = parsed.get("result")
                if isinstance(result, str):
                    try:
                        result = json.loads(result)
                    except (json.JSONDecodeError, TypeError):
                        pass
            result = self._bounded_mcp_json(result, maximum_bytes=131_072, maximum_string=32_768)
        except Exception:
            return {"ok": True, "server": server_name, "tool": tool_name,
                    "status": "error", "error_code": "MCP_TOOL_FAILED", "result": None}
        return {"ok": True, "server": server_name, "tool": tool_name,
                "status": "succeeded", "error_code": None, "result": result}

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
