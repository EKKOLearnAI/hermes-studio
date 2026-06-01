#!/usr/bin/env python3
"""Hermes Quant Lab scheduled brief runner.

This is designed for Hermes no_agent cron jobs. It calls the local Hermes Web
UI Quant Lab endpoint, saves the generated brief to Obsidian through that API,
and prints a concise Telegram-ready summary for cron delivery.
"""

from __future__ import annotations

import csv
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo


WEB_UI_BASE_URL = os.getenv("HERMES_WEB_UI_URL", "http://127.0.0.1:8648").rstrip("/")
TOKEN_PATH = Path(os.getenv(
    "HERMES_WEB_UI_TOKEN_PATH",
    "/Users/kk/Documents/Codex/Hermes-Quant-Workspace/hermes-web-ui/.runtime/.hermes-web-ui/.token",
))
NY_TZ = ZoneInfo("America/New_York")
KB = Path(os.getenv("HERMES_KNOWLEDGE_PATH", "/Users/kk/Documents/Codex/Hermes-Quant-Workspace/hermes-knowledge"))
SUPPLEMENTAL_VALUATION = Path(os.getenv(
    "HERMES_QUANT_SUPPLEMENTAL_VALUATION",
    "/Users/kk/.hermes/profiles/kk/scripts/hermes_quant_supplemental_valuation_caps.py",
))


def nth_weekday(year: int, month: int, weekday: int, nth: int) -> date:
    current = date(year, month, 1)
    days = (weekday - current.weekday()) % 7
    return current + timedelta(days=days + (nth - 1) * 7)


def last_weekday(year: int, month: int, weekday: int) -> date:
    current = date(year, month + 1, 1) - timedelta(days=1) if month < 12 else date(year, 12, 31)
    return current - timedelta(days=(current.weekday() - weekday) % 7)


def easter_date(year: int) -> date:
    a = year % 19
    b = year // 100
    c = year % 100
    d = b // 4
    e = b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i = c // 4
    k = c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day = ((h + l - 7 * m + 114) % 31) + 1
    return date(year, month, day)


def observed_fixed_holiday(year: int, month: int, day: int) -> date:
    holiday = date(year, month, day)
    if holiday.weekday() == 5:
        return holiday - timedelta(days=1)
    if holiday.weekday() == 6:
        return holiday + timedelta(days=1)
    return holiday


def us_market_holidays(year: int) -> set[date]:
    return {
        observed_fixed_holiday(year, 1, 1),
        nth_weekday(year, 1, 0, 3),
        nth_weekday(year, 2, 0, 3),
        easter_date(year) - timedelta(days=2),
        last_weekday(year, 5, 0),
        observed_fixed_holiday(year, 6, 19),
        observed_fixed_holiday(year, 7, 4),
        nth_weekday(year, 9, 0, 1),
        nth_weekday(year, 11, 3, 4),
        observed_fixed_holiday(year, 12, 25),
    }


def is_us_trading_day(day: date) -> bool:
    return day.weekday() < 5 and day not in us_market_holidays(day.year)


def infer_phase() -> str:
    explicit = os.getenv("HERMES_QUANT_LAB_PHASE", "").strip().lower()
    if explicit in {"premarket", "afterclose"}:
        return explicit
    name = Path(sys.argv[0]).stem.lower()
    return "afterclose" if "after" in name or "close" in name else "premarket"


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
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {body}") from exc


def latest_valuation_overlay() -> tuple[str, list[dict[str, str]]]:
    raw_dir = KB / "raw" / "market" / "quant-simulation"
    files = sorted(raw_dir.glob("*-top10-valuation-overlay.csv"))
    if not files:
        return "", []
    latest = files[-1]
    try:
        rows = list(csv.DictReader(latest.open(encoding="utf-8")))
    except Exception:
        return "", []
    date_key = latest.name.replace("-top10-valuation-overlay.csv", "")
    return date_key, rows


def format_valuation_adjusted_section(limit: int = 10) -> list[str]:
    date_key, rows = latest_valuation_overlay()
    if not rows:
        return []
    lines = ["", f"Valuation-adjusted Master Top {min(limit, len(rows))} ({date_key}):"]
    for r in rows[:limit]:
        rank = r.get("valuation_adjusted_rank") or r.get("rank") or "?"
        symbol = r.get("symbol") or "n/a"
        adjusted = r.get("valuation_adjusted_master_score") or r.get("quant_master_score") or "n/a"
        delta = r.get("valuation_master_delta") or "+0.00"
        label = r.get("valuation_adjusted_label") or r.get("quant_label") or "n/a"
        quant_rank = r.get("rank") or "n/a"
        fund = r.get("fundamental_value_score") or "n/a"
        tier = r.get("valuation_risk_tier") or "unknown"
        cap = r.get("valuation_score_cap") or "n/a"
        max_action = r.get("valuation_max_action") or "WATCH"
        ev_fcf = r.get("ev_fcf") or "n/a"
        gap = r.get("base_gap") or "n/a"
        lines.append(
            f"{rank}. {symbol} adj {adjusted} ({delta}) {label} | "
            f"q#{quant_rank} | value {fund} | tier {tier} cap {cap} max {max_action} | EV/FCF {ev_fcf} | gap {gap}"
        )
    return lines


def run_supplemental_valuation_caps() -> str:
    if not SUPPLEMENTAL_VALUATION.exists():
        return "supplemental valuation helper missing"
    proc = subprocess.run(
        [str(SUPPLEMENTAL_VALUATION), "--limit", "5"],
        cwd=str(SUPPLEMENTAL_VALUATION.parent),
        text=True,
        capture_output=True,
        timeout=600,
    )
    output = (proc.stdout or proc.stderr or "").strip()
    if proc.returncode != 0:
        return f"supplemental valuation failed: {output[:240]}"
    try:
        payload = json.loads(output)
        generated = len(payload.get("generated") or [])
        skipped = len(payload.get("skipped") or [])
        candidates = len(payload.get("candidates") or [])
        return f"supplemental valuation checked {candidates}, generated {generated}, skipped {skipped}"
    except Exception:
        return output[:240] or "supplemental valuation completed"


def format_summary(result: dict, phase: str) -> str:
    label = "開盤前" if phase == "premarket" else "收盤後"
    summary = result.get("summary") or {}
    top = result.get("topPicks") or []
    paper = result.get("paper") or {}
    saved = (result.get("saved") or {}).get("relativePath") or "not saved"
    lines = [
        f"HERMES Quant Lab {label}簡報",
        f"Source: {result.get('source', 'unknown')} | Saved: {saved}",
        "",
        str(summary.get("conclusion") or "").strip(),
        str(summary.get("action") or "").strip(),
        "",
        "Top 10:",
    ]
    for idx, pick in enumerate(top[:10], start=1):
        lines.append(
            f"{idx}. {pick.get('ticker')} {pick.get('score')} "
            f"{pick.get('action')} {pick.get('risk')} {pick.get('trend')} - {pick.get('reason')}"
        )
    lines.extend(format_valuation_adjusted_section())
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
    now_ny = datetime.now(NY_TZ)
    if not is_us_trading_day(now_ny.date()):
        return 0

    phase = infer_phase()
    supplemental_status = run_supplemental_valuation_caps()
    result = post_json("/api/hermes/quant-lab/run-brief", {
        "phase": phase,
        "saveReport": True,
        "sendTelegram": False,
    })
    if not result.get("ok"):
        raise RuntimeError(json.dumps(result, ensure_ascii=False))

    print(format_summary(result, phase))
    if supplemental_status:
        print(f"\nValuation cap automation: {supplemental_status}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"Quant Lab brief failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
