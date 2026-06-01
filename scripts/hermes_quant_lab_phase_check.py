#!/usr/bin/env python3
"""Validate Hermes Quant Lab phases in order.

This is intentionally read-mostly. It calls the local Quant Lab validation
endpoint, which can create the missing knowledge/journal directories when
`ensure=1` is used, but it never sends Telegram messages or places orders.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path


BASE_URL = os.environ.get("HERMES_WEB_UI_URL", "http://127.0.0.1:8648").rstrip("/")
TOKEN_PATH = Path(os.environ.get("HERMES_WEB_UI_TOKEN_PATH", ".runtime/.hermes-web-ui/.token"))


def read_token() -> str:
    if not TOKEN_PATH.exists():
        return ""
    return TOKEN_PATH.read_text(encoding="utf-8").strip()


def request_validation() -> dict:
    req = urllib.request.Request(
        f"{BASE_URL}/api/hermes/quant-lab/phase-validation?ensure=1",
        headers={
            "Accept": "application/json",
            **({"Authorization": f"Bearer {read_token()}"} if read_token() else {}),
        },
    )
    with urllib.request.urlopen(req, timeout=120) as res:
        return json.loads(res.read().decode("utf-8"))


def main() -> int:
    try:
        report = request_validation()
    except urllib.error.HTTPError as exc:
        print(f"FAIL HTTP {exc.code}: {exc.read().decode('utf-8', 'replace')}", file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001 - CLI should show the local failure.
        print(f"FAIL {exc}", file=sys.stderr)
        return 2

    print(f"Quant Lab phase validation @ {report.get('generatedAt')}")
    print(f"Source: {report.get('source')} | Quotes: {report.get('quoteCoverage')} | Universe: {report.get('universeSize')}")
    print("")

    for phase in report.get("phases", []):
        print(f"{phase.get('status')} Phase {phase.get('phase')}: {phase.get('title')}")
        for check in phase.get("checks", []):
            print(f"  - {check.get('status')} {check.get('label')}: {check.get('detail')}")
        print("")

    failed = report.get("firstFailedPhase")
    if failed:
        print(
            f"FIRST FAIL: Phase {failed.get('phase')} {failed.get('title')} ({failed.get('key')})",
            file=sys.stderr,
        )
        return 1

    print("ALL PHASES PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
