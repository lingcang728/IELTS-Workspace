# -*- coding: utf-8 -*-
"""Run the installed MinerU against Cambridge IELTS source PDFs.

The runner is intentionally one-book-at-a-time.  Every invocation records the
source hash, page count, MinerU version, backend/effort, command, exit status,
and output hashes in ``data-dev/mineru/Cxx/manifest.json`` so a partial or
failed run is auditable and resumable.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
BOOKS_DIR = Path.home() / "Desktop" / "教材"
MINERU = Path(r"G:\MinerU\.venv\Scripts\mineru.exe")
MODEL_DOWNLOAD = Path(r"G:\MinerU\.venv\Scripts\mineru-models-download.exe")
BOOK_RE = re.compile(r"真题(\d+)")


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def book_number(path: Path) -> int | None:
    match = BOOK_RE.search(path.stem)
    return int(match.group(1)) if match else None


def choose_pdf(book: int) -> Path:
    candidates = [p for p in BOOKS_DIR.glob("*.pdf") if book_number(p) == book]
    if not candidates:
        raise FileNotFoundError(f"No Cambridge PDF found for C{book}")
    if book == 20:
        official = [p for p in candidates if "官方" in p.stem]
        if official:
            return official[0]
    return sorted(candidates, key=lambda p: ("抢先" in p.stem, len(p.name), p.name))[0]


def page_count(pdf: Path) -> int | None:
    pdfinfo = shutil.which("pdfinfo")
    if not pdfinfo:
        return None
    try:
        result = subprocess.run([pdfinfo, str(pdf)], capture_output=True, text=True, timeout=60)
        match = re.search(r"^Pages:\s+(\d+)", result.stdout, re.MULTILINE)
        return int(match.group(1)) if match else None
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def mineru_version() -> str | None:
    try:
        result = subprocess.run([str(MINERU), "--version"], capture_output=True, text=True, timeout=60)
        text = (result.stdout or result.stderr).strip()
        return text or None
    except (OSError, subprocess.SubprocessError):
        return None


def output_hashes(output: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for path in sorted(output.rglob("*")):
        if not path.is_file() or path.name == "manifest.json":
            continue
        try:
            rows.append({"path": str(path.relative_to(output)), "bytes": path.stat().st_size, "sha256": digest(path)})
        except OSError:
            continue
    return rows


def ensure_vlm() -> int:
    if not MODEL_DOWNLOAD.exists():
        print(f"MinerU model downloader not found: {MODEL_DOWNLOAD}", file=sys.stderr)
        return 2
    print("补齐 MinerU VLM 模型（复用现有 G:\\build_cache / ModelScope 缓存）…")
    return subprocess.run([str(MODEL_DOWNLOAD), "-s", "modelscope", "-m", "vlm"], cwd=str(ROOT)).returncode


def run_book(book: int, backend: str, effort: str, method: str | None, start: int | None, end: int | None, force: bool) -> int:
    if not MINERU.exists():
        print(f"MinerU executable not found: {MINERU}", file=sys.stderr)
        return 2
    pdf = choose_pdf(book)
    output = ROOT / "data-dev" / "mineru" / f"C{book:02d}"
    output.mkdir(parents=True, exist_ok=True)
    manifest_path = output / "manifest.json"
    old = None
    if manifest_path.exists():
        try:
            old = json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            old = None
    source_hash = digest(pdf)
    requested = {"backend": backend, "effort": effort, "method": method, "start": start, "end": end}
    if not force and old and old.get("status") == "ok" and old.get("source", {}).get("sha256") == source_hash and old.get("run", {}).get("options") == requested:
        print(f"C{book:02d}: 已存在同源成功输出，跳过（--force 可重跑）")
        return 0
    cmd = [str(MINERU), "-p", str(pdf), "-o", str(output), "-b", backend, "--effort", effort, "--table", "True", "--formula", "True"]
    if method:
        cmd.extend(["-m", method])
    if start is not None:
        cmd.extend(["-s", str(start)])
    if end is not None:
        cmd.extend(["-e", str(end)])
    started = utc_now()
    log_path = output / "mineru.log"
    print(f"C{book:02d}: {pdf.name} -> {output}")
    with log_path.open("a", encoding="utf-8") as log:
        log.write(f"\n[{started}] COMMAND {json.dumps(cmd, ensure_ascii=False)}\n")
        result = subprocess.run(cmd, cwd=str(ROOT), stdout=log, stderr=subprocess.STDOUT, text=True)
    status = "ok" if result.returncode == 0 else "failed"
    manifest = {
        "schemaVersion": 1,
        "status": status,
        "startedAt": started,
        "finishedAt": utc_now(),
        "source": {"path": str(pdf), "sha256": source_hash, "bytes": pdf.stat().st_size, "pages": page_count(pdf)},
        "mineru": {"version": mineru_version(), "executable": str(MINERU)},
        "run": {"options": requested, "command": cmd, "returncode": result.returncode},
        "outputs": output_hashes(output),
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"C{book:02d}: {status}, returncode={result.returncode}, outputs={len(manifest['outputs'])}")
    return result.returncode


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--book", type=int, action="append", dest="books", help="book number; repeat or omit for all 4..21")
    parser.add_argument("--backend", choices=("pipeline", "vlm-engine", "hybrid-engine"), default="hybrid-engine")
    parser.add_argument("--effort", choices=("medium", "high"), default="medium")
    parser.add_argument("--method", choices=("auto", "txt", "ocr"), default=None)
    parser.add_argument("--start", type=int, default=None, help="zero-based first page")
    parser.add_argument("--end", type=int, default=None, help="zero-based last page")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--ensure-vlm", action="store_true")
    args = parser.parse_args()
    if args.ensure_vlm:
        code = ensure_vlm()
        if code:
            return code
    books = args.books or list(range(4, 22))
    bad = 0
    for book in books:
        if book not in range(4, 22):
            print(f"unsupported book {book}; expected 4..21", file=sys.stderr)
            bad += 1
            continue
        code = run_book(book, args.backend, args.effort, args.method, args.start, args.end, args.force)
        if code:
            bad += 1
            # Do not launch several GPU jobs; caller can retry this one book
            # with --backend pipeline --method ocr after two failures.
            if args.books:
                break
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
