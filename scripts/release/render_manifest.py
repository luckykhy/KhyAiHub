#!/usr/bin/env python3
"""Render MANIFEST.in from the shared pip packaging rules."""

from __future__ import annotations

import sys
from pathlib import Path

# PYTHONSAFEPATH (or `python -P`) omits the script directory from sys.path,
# breaking the sibling import below — the same failure check_manifest_sync.py
# already guards against. Without this line the remediation command printed by
# that guard ("Re-run: python3 scripts/release/render_manifest.py") dies with
# ModuleNotFoundError: pip_packaging_rules, so a red manifest-sync gate had no
# working repair path. Keep the import location-independent.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from pip_packaging_rules import render_manifest  # noqa: E402


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    manifest_path = root / "MANIFEST.in"
    manifest_path.write_text(render_manifest(), encoding="utf-8")
    print(f"Rendered {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
