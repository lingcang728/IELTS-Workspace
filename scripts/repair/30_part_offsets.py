# -*- coding: utf-8 -*-
"""Stage 4 — compute Part boundaries inside the concatenated listening MP3s.

``fixtures/assets/cambridge/`` holds one merged MP3 per test, but the original
per-part files under ``听力/剑N/TestN/`` are still on disk. Their durations are
all the Part boundaries need to be: Part 2 starts where Part 1 ends. That makes
"jump to Part 3" free for every listening test, with no audio analysis and no
transcript alignment.

Boundaries are written to ``data-dev/repair/part-offsets.json``, not straight
into the fixtures -- ``40_apply.py`` is the only writer, so a rerun here can
never clobber a hand-corrected overlay.
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import AUDIO_BOOKS, REPAIR, ROOT, exam_id, load_exam, write_json  # noqa: E402

LISTENING_ROOT = ROOT / "听力"
ASSET_ROOT = ROOT / "fixtures" / "assets" / "cambridge"
# Cambridge switched the on-disk naming between books; accept both.
PART_NAMES = ("Part{}.mp3", "Section{}.mp3", "Part{}.m4a", "Section{}.m4a",
              "Part{}.wav", "Section{}.wav")
# The merged file is re-encoded, so a small drift from the sum of the parts is
# expected. More than this means the merge did not use these parts.
TOLERANCE_SECONDS = 12.0


def ffprobe() -> str | None:
    found = shutil.which("ffprobe")
    if found:
        return found
    candidates = [
        Path(r"C:\Users\15pro\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg.Shared_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.0.1-full_build\bin\ffprobe.exe"),
        Path(r"C:\Users\15pro\scoop\shims\ffprobe.exe"),
    ]
    return next((str(p) for p in candidates if p.exists()), None)


def duration(binary: str, path: Path) -> float | None:
    try:
        result = subprocess.run(
            [binary, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True, text=True, timeout=60,
        )
        if result.returncode != 0:
            return None
        return float(result.stdout.strip())
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def test_dir(book: int, test: int) -> Path | None:
    """Locate a test's per-part folder.

    Usually ``听力/剑N/TestN``, but Cambridge 12's download numbers its folders
    Test5-Test8 (continuing Cambridge 11's numbering rather than restarting),
    so fall back to the book's folders in sorted order and take the Nth.
    """
    book_dir = LISTENING_ROOT / f"剑{book}"
    direct = book_dir / f"Test{test}"
    if direct.is_dir():
        return direct
    if not book_dir.is_dir():
        return None
    folders = sorted(
        (p for p in book_dir.iterdir() if p.is_dir() and p.name.lower().startswith("test")),
        key=lambda p: int("".join(c for c in p.name if c.isdigit()) or 0),
    )
    return folders[test - 1] if len(folders) >= test else None


def part_files(book: int, test: int) -> list[Path | None]:
    base = test_dir(book, test)
    if base is None:
        return [None, None, None, None]
    out: list[Path | None] = []
    for index in (1, 2, 3, 4):
        found = None
        for template in PART_NAMES:
            candidate = base / template.format(index)
            if candidate.exists():
                found = candidate
                break
        out.append(found)
    return out


def measure(book: int, test: int, binary: str) -> dict[str, Any]:
    exam = load_exam(book, test, "listening")
    record: dict[str, Any] = {"book": book, "test": test, "examId": exam_id(book, test, "listening")}
    if exam is None:
        return {**record, "ok": False, "reason": "no listening fixture"}

    files = part_files(book, test)
    missing = [index + 1 for index, path in enumerate(files) if path is None]
    if missing:
        return {**record, "ok": False, "reason": f"missing per-part audio for parts {missing}"}

    durations = [duration(binary, path) for path in files if path]
    if any(value is None for value in durations):
        return {**record, "ok": False, "reason": "ffprobe could not read a part file"}

    offsets: list[int] = []
    running = 0.0
    for value in durations:
        offsets.append(round(running * 1000))
        running += float(value)

    merged = ASSET_ROOT / f"c{book:02d}-t{test}.mp3"
    merged_duration = duration(binary, merged) if merged.exists() else None
    drift = None if merged_duration is None else merged_duration - running
    ok = merged_duration is not None and abs(drift or 0) <= TOLERANCE_SECONDS
    return {
        **record,
        "ok": ok,
        "reason": None if ok else (
            "merged MP3 missing" if merged_duration is None
            else f"merged duration differs from the sum of parts by {drift:.1f}s"
        ),
        "sectionIds": [section["id"] for section in exam.get("sections") or []],
        "partOffsetsMs": offsets,
        "partDurationsMs": [round(float(value) * 1000) for value in durations],
        "sumSeconds": round(running, 2),
        "mergedSeconds": None if merged_duration is None else round(merged_duration, 2),
        "driftSeconds": None if drift is None else round(drift, 2),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--books", type=str, default="")
    parser.add_argument("--out", type=Path, default=REPAIR / "part-offsets.json")
    args = parser.parse_args()
    binary = ffprobe()
    if not binary:
        print("ffprobe not found; install ffmpeg or add it to PATH", file=sys.stderr)
        return 1
    books = [int(b) for b in args.books.split(",") if b.strip()] or list(AUDIO_BOOKS)

    results = []
    print(f"{'Exam':<34}{'parts (mm:ss)':>34}{'drift':>9}")
    for book in books:
        for test in (1, 2, 3, 4):
            record = measure(book, test, binary)
            results.append(record)
            if not record.get("ok"):
                print(f"{record['examId']:<34}{'':>34}{'':>9}  SKIP: {record['reason']}")
                continue
            stamps = " ".join(f"{ms // 60000:02d}:{ms // 1000 % 60:02d}" for ms in record["partOffsetsMs"])
            print(f"{record['examId']:<34}{stamps:>34}{record['driftSeconds']:>8.1f}s")

    write_json(args.out, {"schemaVersion": 1, "toleranceSeconds": TOLERANCE_SECONDS, "results": results})
    ok = [r for r in results if r.get("ok")]
    print(f"\n{len(ok)}/{len(results)} tests have usable Part boundaries → {args.out}")
    for record in results:
        if not record.get("ok"):
            print(f"  WARN {record['examId']}: {record['reason']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
