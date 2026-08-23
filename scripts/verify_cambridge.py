# -*- coding: utf-8 -*-
"""Validate the canonical Cambridge IELTS content and audio corpus.

The importer is deliberately conservative: this script is the hard gate used by
``verify.ps1`` and can also be run with ``--partial`` while MinerU is rebuilding
the corpus. It never mutates fixtures; it writes an evidence report instead.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


BOOKS = tuple(range(4, 22))
AUDIO_BOOKS = tuple(range(4, 21))
MODULES = ("listening", "reading", "writing")
EXPECTED_EXAMS = (len(BOOKS) * 4 * 2) + (len(AUDIO_BOOKS) * 4)
EXPECTED_AUDIO = len(AUDIO_BOOKS) * 4
PLACEHOLDER_RE = re.compile(r"^\s*(?:Question|题目|问题)\s*\d+\s*$", re.I)
WATERMARKS = (
    "沪江", "学习交流", "建议购买正版", "仅供学习", "扫描二维码", "www.hjenglish.com",
    "www.", "更多资料", "版权所有", "未经许可",
)
CHOICE_TYPES = {"single_choice", "multi_choice", "matching", "labelling"}
MIN_AUDIO_SECONDS = 900
# One legacy Cambridge recording (C14 Test 2) contains the long transfer
# pauses between parts and is just over 40 minutes.  Keep the gate broad
# enough for a complete, decodable recording while still rejecting truncated
# or unrelated files.
MAX_AUDIO_SECONDS = 2700


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def add(errors: list[str], path: Path | str, message: str) -> None:
    errors.append(f"{path}: {message}")


def resolve_asset(root: Path, rel: str) -> Path:
    """Resolve the schema's fixture-relative asset path.

    Exam JSON stores paths such as ``assets/cambridge/c04-t1.mp3`` while the
    repository keeps them under ``fixtures``.  Accept both forms so the gate
    also works against an exported data directory.
    """
    direct = root / rel
    if direct.exists():
        return direct
    return root / "fixtures" / rel


def iter_questions(exam: dict[str, Any]):
    for section in exam.get("sections") or []:
        for group in section.get("questionGroups") or []:
            for question in group.get("questions") or []:
                yield section, group, question


def validate_exam(path: Path, root: Path, errors: list[str], seen_ids: dict[str, str]) -> dict[str, Any] | None:
    try:
        exam = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        add(errors, path, f"invalid JSON ({exc})")
        return None
    if not isinstance(exam, dict):
        add(errors, path, "root must be an object")
        return None
    if exam.get("schemaVersion") != 1:
        add(errors, path, "schemaVersion must be 1")
    exam_id = str(exam.get("id") or "")
    if not exam_id:
        add(errors, path, "missing id")
    elif exam_id in seen_ids:
        add(errors, path, f"duplicate id (also {seen_ids[exam_id]})")
    else:
        seen_ids[exam_id] = str(path)
    module = exam.get("module")
    if module not in MODULES:
        add(errors, path, f"unsupported module {module!r}")
    sections = exam.get("sections") or []
    expected_sections = {"reading": 3, "listening": 4, "writing": 2}.get(module)
    if expected_sections is not None and len(sections) != expected_sections:
        add(errors, path, f"{module} must contain {expected_sections} sections, got {len(sections)}")
    if not exam.get("source"):
        add(errors, path, "missing source metadata")
    source = exam.get("source") or {}
    if module in ("reading", "listening") and not source.get("provenance"):
        add(errors, path, "missing source.provenance")

    questions = list(iter_questions(exam))
    expected_q = 40 if module in ("reading", "listening") else 0
    if len(questions) != expected_q:
        add(errors, path, f"{module} must contain {expected_q} questions, got {len(questions)}")
    numbers: set[int] = set()
    for section, group, question in questions:
        qid = str(question.get("id") or "")
        if not qid:
            add(errors, path, "question missing id")
        elif qid in seen_ids:
            add(errors, path, f"duplicate question id {qid} (also {seen_ids[qid]})")
        else:
            seen_ids[qid] = str(path)
        number = question.get("number")
        if not isinstance(number, int) or not 1 <= number <= 40:
            add(errors, path, f"invalid question number {number!r}")
        elif number in numbers:
            add(errors, path, f"duplicate question number {number}")
        else:
            numbers.add(number)
        prompt = str(question.get("prompt") or "").strip()
        if not prompt:
            add(errors, path, f"question {number} has empty prompt")
        elif PLACEHOLDER_RE.fullmatch(prompt):
            add(errors, path, f"question {number} still has placeholder prompt")
        lowered = prompt.lower()
        for watermark in WATERMARKS:
            if watermark.lower() in lowered:
                add(errors, path, f"question {number} contains watermark text {watermark!r}")
        if module in ("reading", "listening"):
            accepted = question.get("acceptedAnswers") or []
            if not isinstance(accepted, list) or not any(str(x).strip() for x in accepted):
                add(errors, path, f"question {number} has no accepted answer")
        qtype = question.get("type")
        if qtype in CHOICE_TYPES:
            options = question.get("options") or group.get("sharedOptions") or []
            if len(options) < 2:
                add(errors, path, f"choice question {number} has fewer than two options")
        if question.get("imageAsset"):
            asset = resolve_asset(root, str(question["imageAsset"]))
            if not asset.exists():
                add(errors, path, f"missing question asset {question['imageAsset']}")
    if module in ("reading", "listening") and numbers != set(range(1, 41)):
        missing = sorted(set(range(1, 41)) - numbers)
        add(errors, path, f"question numbers are not 1..40; missing {missing}")
    if module == "writing" and len(sections) != 2:
        add(errors, path, "writing must contain Task 1 and Task 2")
    for section in sections:
        text = str((section.get("content") or {}).get("text") or "")
        for watermark in WATERMARKS:
            if watermark.lower() in text.lower():
                add(errors, path, f"section {section.get('id')} contains watermark text {watermark!r}")
        audio = section.get("audioAsset")
        if module == "listening" and not audio:
            add(errors, path, f"listening section {section.get('id')} has no audioAsset")
        if audio and not resolve_asset(root, str(audio)).exists():
            add(errors, path, f"missing audio asset {audio}")
    return {
        "id": exam_id,
        "module": module,
        "sections": len(sections),
        "questions": len(questions),
        "sha256": sha256(path),
        "provenance": source.get("provenance"),
    }


def ffprobe_duration(path: Path) -> float | None:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        candidates = [
            Path(r"C:\Users\15pro\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg.Shared_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.0.1-full_build\bin\ffprobe.exe"),
            Path(r"C:\Users\15pro\scoop\shims\ffprobe.exe"),
        ]
        ffprobe = next((str(p) for p in candidates if p.exists()), None)
    if not ffprobe:
        return None
    try:
        result = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True, text=True, timeout=45,
        )
        if result.returncode != 0:
            return None
        return float(result.stdout.strip())
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def validate_audio(asset_root: Path, errors: list[str], partial: bool) -> dict[str, Any]:
    expected = {f"c{book:02d}-t{test}.mp3" for book in AUDIO_BOOKS for test in range(1, 5)}
    actual = {p.name.lower() for p in asset_root.glob("c*.mp3")}
    missing = sorted(expected - actual)
    if missing and not partial:
        add(errors, asset_root, f"missing {len(missing)} expected listening MP3s: {', '.join(missing[:8])}")
    durations: dict[str, float | None] = {}
    for name in sorted(actual & expected):
        path = asset_root / name
        duration = ffprobe_duration(path)
        durations[name] = duration
        if duration is None:
            add(errors, path, "ffprobe could not decode the file")
        elif not MIN_AUDIO_SECONDS <= duration <= MAX_AUDIO_SECONDS:
            add(errors, path, f"duration {duration:.2f}s is outside the expected range")
    return {"expected": len(expected), "actualExpected": len(actual & expected), "missing": missing, "durations": durations}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--report", type=Path, default=None)
    parser.add_argument("--partial", action="store_true", help="allow missing books/assets while rebuilding")
    parser.add_argument("--skip-audio", action="store_true")
    args = parser.parse_args()
    root = args.root.resolve()
    exam_root = root / "fixtures" / "cambridge"
    asset_root = root / "fixtures" / "assets" / "cambridge"
    report_path = (args.report or (root / "data-dev" / "cambridge-qa-report.json")).resolve()
    errors: list[str] = []
    seen_ids: dict[str, str] = {}
    exam_reports: list[dict[str, Any]] = []
    files = sorted(exam_root.glob("*.json")) if exam_root.exists() else []
    if not args.partial and len(files) != EXPECTED_EXAMS:
        add(errors, exam_root, f"expected {EXPECTED_EXAMS} exam JSON files, got {len(files)}")
    for path in files:
        result = validate_exam(path, root, errors, seen_ids)
        if result:
            exam_reports.append(result)
    key = set()
    for report in exam_reports:
        match = re.match(r"^cambridge-(\d+)-test-(\d+)-", report["id"])
        if match:
            key.add((match.group(1), match.group(2), report["module"]))
    expected_keys = {
        (str(book), str(test), module)
        for book in BOOKS
        for test in range(1, 5)
        for module in (MODULES if book in AUDIO_BOOKS else ("reading", "writing"))
    }
    if not args.partial:
        missing = sorted(expected_keys - key)
        if missing:
            add(errors, exam_root, f"missing exam combinations: {missing[:12]}")
    audio_report = {"skipped": True}
    if not args.skip_audio:
        audio_report = validate_audio(asset_root, errors, args.partial)
    report = {
        "schemaVersion": 1,
        "ok": not errors,
        "partial": args.partial,
        "expected": {
            "books": list(BOOKS),
            "audioBooks": list(AUDIO_BOOKS),
            "examJson": EXPECTED_EXAMS,
            "audio": EXPECTED_AUDIO,
        },
        "actual": {"examJson": len(files), "reports": exam_reports, "audio": audio_report},
        "errors": errors,
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": report["ok"], "examJson": len(files), "errors": len(errors), "report": str(report_path)}, ensure_ascii=False))
    if errors:
        for line in errors[:80]:
            print(f"ERROR {line}", file=sys.stderr)
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
