# -*- coding: utf-8 -*-
"""Build a keep/delete inventory before any permanent deletion.

    python scripts/inventory_resources.py
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data-dev" / "resource-inventory.json"

KEEP_AUDIO_BOOKS = set(range(4, 21))
KEEP_PDF_NAMES = {
    f"剑桥雅思真题{n}.pdf" for n in range(4, 22) if n != 20
} | {"剑桥雅思真题20-官方扫描.pdf"}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def classify(rel: str, path: Path) -> tuple[str, str]:
    posix = rel.replace("\\", "/")
    name = path.name
    if posix.startswith("听力/剑") and posix.split("/")[1][1:].isdigit():
        book = int(posix.split("/")[1][1:])
        if book in (1, 2, 3):
            return "delete", "剑1–3 音频不在支持范围"
        if book == 21:
            return "delete", "C21 听力音频未验证"
        if book in KEEP_AUDIO_BOOKS:
            return "keep", "剑4–20 四段原音频"
    if posix.startswith("教材/"):
        if name == "剑桥雅思真题20-抢先版拼合.pdf":
            return "delete", "剑20 只保留官方扫描"
        if name in KEEP_PDF_NAMES or name in {"manifest.csv", "README.md"}:
            return "keep", "正式教材或来源清单"
        return "delete", "非保留教材文件"
    if posix.startswith("fixtures/assets/cambridge/") and name.endswith(".mp3"):
        return "delete", "衍生整轨，四段制不再使用"
    if posix.startswith("fixtures/assets/cambridge/") and name.endswith((".jpg", ".png")):
        return "keep", "地图/图表"
    if posix.startswith("fixtures/cambridge/") or posix.startswith("fixtures/overlays/"):
        return "keep", "题库或人工 overlay"
    if posix.startswith("fixtures/answer-keys/") or posix.startswith("fixtures/transcripts/"):
        return "keep", "答案键或听力原文"
    if posix.startswith("schema/") or posix == "fixtures/cambridge-health-baseline.json":
        return "keep", "schema 或健康度基线"
    if posix.startswith("output/listening-audio-v1/"):
        return "delete", "旧整轨打包产物"
    if posix.startswith("data-dev/quarantine/"):
        return "delete", "未验证音频隔离区"
    if posix.startswith("dist/") or posix.startswith("site-dist/"):
        return "delete", "可再生成前端产物"
    if name in {"__pycache__"} or name.endswith(".pyc"):
        return "delete", "Python 缓存"
    if posix.startswith("scripts/") and name.startswith("_"):
        return "delete", "一次性诊断输出"
    if posix.startswith("_raw/"):
        return "delete", "一次性抓取/截图"
    return "review", "未分类，删除前再看"


def walk_targets() -> list[Path]:
    roots = [
        ROOT / "听力",
        ROOT / "教材",
        ROOT / "fixtures" / "assets" / "cambridge",
        ROOT / "output" / "listening-audio-v1",
        ROOT / "data-dev" / "quarantine",
        ROOT / "_raw",
        ROOT / "dist",
        ROOT / "site-dist",
        ROOT / "scripts",
    ]
    files: list[Path] = []
    for root in roots:
        if not root.exists():
            continue
        if root.is_file():
            files.append(root)
            continue
        for path in root.rglob("*"):
            if path.is_file():
                files.append(path)
    return files


def main() -> None:
    rows = []
    for path in walk_targets():
        rel = path.relative_to(ROOT).as_posix()
        action, reason = classify(rel, path)
        rows.append({
            "path": rel,
            "bytes": path.stat().st_size,
            "sha256": sha256(path) if action != "review" or path.stat().st_size < 80_000_000 else None,
            "source": path.parent.as_posix(),
            "action": action,
            "reason": reason,
        })
    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "files": rows,
        "counts": {
            "keep": sum(1 for r in rows if r["action"] == "keep"),
            "delete": sum(1 for r in rows if r["action"] == "delete"),
            "review": sum(1 for r in rows if r["action"] == "review"),
            "deleteBytes": sum(r["bytes"] for r in rows if r["action"] == "delete"),
        },
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(payload["counts"], ensure_ascii=False, indent=2))
    print("wrote", OUT)


if __name__ == "__main__":
    main()
