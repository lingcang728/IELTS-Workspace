# -*- coding: utf-8 -*-
"""Permanently delete inventory rows marked action=delete.

Keep-set is checked first: 272 C4-20 audio files and official textbooks
must still exist. Does not touch G:\\build_cache or LocalAppData.

    python scripts/apply_inventory_deletes.py
"""
from __future__ import annotations

import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INV = ROOT / "data-dev" / "resource-inventory.json"


def main() -> None:
    inv = json.loads(INV.read_text(encoding="utf-8"))
    keep_audio = [
        r["path"]
        for r in inv["files"]
        if r["action"] == "keep" and r["path"].startswith("听力/")
    ]
    if len(keep_audio) != 272:
        raise SystemExit(f"keep audio is {len(keep_audio)}, expected 272")
    for rel in keep_audio:
        if not (ROOT / rel).is_file():
            raise SystemExit(f"missing keep file: {rel}")
    official = ROOT / "教材" / "剑桥雅思真题20-官方扫描.pdf"
    if not official.is_file():
        raise SystemExit("missing official C20 scan")
    deleted = 0
    bytes_removed = 0
    for row in inv["files"]:
        if row["action"] != "delete":
            continue
        path = ROOT / row["path"]
        if not path.exists():
            continue
        bytes_removed += path.stat().st_size
        path.unlink()
        deleted += 1
    print(f"deleted {deleted} files, {bytes_removed} bytes")


if __name__ == "__main__":
    main()
