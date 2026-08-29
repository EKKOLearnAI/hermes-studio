"""Tests for the local OCR helper entry points."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest


SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"


def run(script: str, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPTS / script), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )


def test_helpers_expose_non_loading_help() -> None:
    for script in ("extract_pymupdf.py", "extract_marker.py"):
        result = run(script, "--help")
        assert result.returncode == 0
        assert "--output" in result.stdout


def test_marker_disk_check_does_not_import_marker() -> None:
    result = run("extract_marker.py", "--check")
    assert result.returncode in (0, 1)
    assert "GB" in result.stdout


def test_pymupdf_writes_requested_output(tmp_path: Path) -> None:
    pymupdf = pytest.importorskip("pymupdf")
    source = tmp_path / "source.pdf"
    document = pymupdf.open()
    page = document.new_page()
    page.insert_text((72, 72), "OCR helper smoke test")
    document.save(source)
    output = tmp_path / "extracted.txt"

    result = run("extract_pymupdf.py", str(source), "--output", str(output))

    assert result.returncode == 0, result.stderr
    assert "OCR helper smoke test" in output.read_text(encoding="utf-8")
