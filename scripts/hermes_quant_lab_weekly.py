#!/usr/bin/env python3
"""Hermes Quant Lab weekly summary runner.

Calls the local Hermes Web UI weekly summary endpoint, saves the generated
report to the knowledge vault through the server API, and prints a concise
Telegram-ready weekly summary for Hermes cron delivery.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path


WEB_UI_BASE_URL = os.getenv("HERMES_WEB_UI_URL", "http://127.0.0.1:8648").rstrip("/")
TOKEN_PATH = Path(os.getenv(
    "HERMES_WEB_UI_TOKEN_PATH",
    "/Users/kk/Documents/Codex/Hermes-Quant-Workspace/hermes-web-ui/.runtime/.hermes-web-ui/.token",
))


def read_token() -> str:
    env_token = os.getenv("HERMES_WEB_UI_TOKEN", "").strip()
    if env_token:
        return env_token
    if TOKEN_PATH.exists():
        return TOKEN_PATH.read_text(encoding="utf-8").strip()
    raise RuntimeError(f"Missing Hermes Web UI token at {TOKEN_PATH}")


def post_json(path: str, payload: dict) -> dict:
    token = read_token()
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{WEB_UI_BASE_URL}{path}",
        data=data,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {body}") from exc


def format_summary(result: dict) -> str:
    summary = result.get("summary") or {}
    top = result.get("topPicks") or []
    paper = result.get("paper") or {}
    saved = (result.get("saved") or {}).get("relativePath") or "not saved"
    source_briefs = result.get("sourceBriefs") or []
    lines = [
        "HERMES Quant Lab 每週總結",
        f"Source: {result.get('source', 'unknown')} | Saved: {saved}",
        f"Daily briefs used: {len(source_briefs)}",
        "",
        str(summary.get("conclusion") or "").strip(),
        str(summary.get("action") or "").strip(),
        "",
        "Weekly Top 10:",
    ]
    for idx, pick in enumerate(top[:10], start=1):
        lines.append(
            f"{idx}. {pick.get('ticker')} {pick.get('score')} "
            f"{pick.get('action')} {pick.get('risk')} {pick.get('trend')} - {pick.get('reason')}"
        )
    if paper:
        lines.extend([
            "",
            "Paper KPI:",
            f"Equity ${paper.get('equity', 'n/a')} | Cash ${paper.get('cash', 'n/a')} | "
            f"P/L {paper.get('returnPct', 'n/a')}% | Max DD {paper.get('maxDrawdownPct', 'n/a')}%",
            f"Positions: {paper.get('positions', 'n/a')}",
        ])
    lines.extend([
        "",
        f"Risk: {summary.get('invalidation') or 'n/a'}",
        "Paper trading only. No real orders.",
    ])
    return "\n".join(line for line in lines if line is not None).strip()


def main() -> int:
    result = post_json("/api/hermes/quant-lab/run-weekly-summary", {
        "saveReport": True,
        "sendTelegram": False,
    })
    if not result.get("ok"):
        raise RuntimeError(json.dumps(result, ensure_ascii=False))

    print(format_summary(result))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"Quant Lab weekly summary failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
