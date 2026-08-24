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
# Exact strings the importer has emitted in place of a real question stem.
# Matched case-insensitively after stripping; add to this list, never widen the
# regex above -- a loose regex is what let 1425 placeholder prompts through.
PLACEHOLDER_PROMPTS = {
    "write the answer from the source question.",
    "write the answer from the source question",
    "answer the question from the source.",
    "see the source question.",
    "todo",
    "placeholder",
    "n/a",
    "-",
}
# A completion stem has to show the test-taker where the gap is. Table and
# flow-chart layouts put the placeholder in `group.layoutHtml` instead, which is
# checked separately.
GAP_MARKER_RE = re.compile(r"_{2,}|\.{3,}|…{1,}|\{\{\s*q\s*:|\[\s*\d+\s*\]|\bblank\b", re.I)
COMPLETION_TYPES = {"completion", "short_answer"}
# A bare capital letter is an option label, not a word to type into a gap.
# An English IELTS answer is never CJK text, a tick/cross, or a box glyph.
# All of these turned up in acceptedAnswers: the scanned answer page's
# watermark, table rules, and check marks were OCR'd as answers.
BAD_ANSWER_RE = re.compile(r"[　-〿一-鿿＀-￯✓✗√×□○☐]")
SINGLE_LETTER_RE = re.compile(r"^[A-J]$")
OPTIONED_TYPES = {"single_choice", "multi_choice", "matching", "labelling"}
# Audio transcript sliced mid-word: a stem never starts lowercase or on
# punctuation. `'` is allowed for quoted stems like "'Green' technology ...".
TRANSCRIPT_SLICE_RE = re.compile(r"^[a-z,.;:!?)\]}]")
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


def validate_exam(path: Path, root: Path, errors: list[str], damage: list[str], warnings: list[str], seen_ids: dict[str, str]) -> dict[str, Any] | None:
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
    # Damage is counted per question so `--health` can show a real repair
    # dashboard instead of a single pass/fail bit.
    damaged: set[int] = set()
    suspect: set[int] = set()
    prompt_owners: dict[str, int] = {}
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
        lowered = prompt.lower()
        qtype = question.get("type")
        options = question.get("options") or group.get("sharedOptions") or []
        accepted = question.get("acceptedAnswers") or []
        slot = number if isinstance(number, int) else -1

        def broken(message: str) -> None:
            add(damage, path, f"question {number} {message}")
            damaged.add(slot)

        def suspicious(message: str) -> None:
            add(warnings, path, f"question {number} {message}")
            suspect.add(slot)

        if not prompt:
            broken("has empty prompt")
        elif PLACEHOLDER_RE.fullmatch(prompt):
            broken("still has placeholder prompt")
        elif lowered in PLACEHOLDER_PROMPTS:
            broken(f"has boilerplate placeholder prompt {prompt!r}")
        elif module in ("reading", "listening"):
            # (1) Within one paper every stem is distinct. This single check
            #     would have caught all 1425 placeholder questions on day one.
            if prompt in prompt_owners:
                broken(f"repeats the prompt of question {prompt_owners[prompt]}: {prompt[:60]!r}")
            else:
                prompt_owners[prompt] = number
            # (3) Stems sliced out of the audio transcript start mid-sentence.
            if TRANSCRIPT_SLICE_RE.match(prompt):
                broken(f"prompt starts mid-sentence (transcript slice?): {prompt[:60]!r}")

        for watermark in WATERMARKS:
            if watermark.lower() in lowered:
                broken(f"contains watermark text {watermark!r}")
        if module in ("reading", "listening"):
            if not isinstance(accepted, list) or not any(str(x).strip() for x in accepted):
                broken("has no accepted answer")
            # The answer key was assumed trustworthy until the repair pipeline's
            # calibration batch turned up answers like "张听力录音光盘", "口 2 ×"
            # and "✓ ✗": OCR of the scanned answer page picked up watermark,
            # table rules and tick marks and stored them as answers.
            for value in accepted:
                if BAD_ANSWER_RE.search(str(value)):
                    broken(f"has OCR junk in acceptedAnswers: {str(value)[:24]!r}")
                    break
        if qtype in CHOICE_TYPES:
            if len(options) < 2:
                broken("is a choice question with fewer than two options")
        # (4) A single capital letter answer means an option-labelled question.
        #     `completion` was outside CHOICE_TYPES, so 53 mislabelled questions
        #     rendered as text boxes whose only accepted answer was "E".
        letters = [str(x).strip() for x in accepted if SINGLE_LETTER_RE.fullmatch(str(x).strip())]
        if letters and len(letters) == len([x for x in accepted if str(x).strip()]):
            if qtype not in OPTIONED_TYPES:
                broken(f"answers with option letters {letters} but is typed {qtype!r}")
            elif len(options) < 2:
                broken(f"answers with option letters {letters} but carries no options")
        # (5) Completion stems must show the gap, unless the placeholder lives
        #     in the group's table/flow-chart layout instead.
        if qtype in COMPLETION_TYPES and prompt and not GAP_MARKER_RE.search(prompt):
            layout = str(group.get("layoutHtml") or "")
            gap_text = str(question.get("gapText") or "")
            if f"{{{{q:{qid}}}}}" not in layout.replace(" ", "") and not GAP_MARKER_RE.search(gap_text):
                suspicious(f"is a completion question with no gap marker: {prompt[:60]!r}")
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
        "damaged": len(damaged),
        "suspect": len(suspect - damaged),
        "healthy": max(0, len(questions) - len(damaged)),
        "sha256": sha256(path),
        "provenance": source.get("provenance"),
    }


def build_health(exam_reports: list[dict[str, Any]]) -> dict[str, Any]:
    """Per-book, per-module repair dashboard, used as the Phase 1 progress board."""
    rows: dict[tuple[int, str], dict[str, int]] = {}
    for report in exam_reports:
        match = re.match(r"^cambridge-(\d+)-test-(\d+)-", str(report.get("id") or ""))
        if not match:
            continue
        key = (int(match.group(1)), str(report.get("module")))
        row = rows.setdefault(key, {"questions": 0, "damaged": 0, "suspect": 0, "exams": 0})
        row["questions"] += int(report.get("questions") or 0)
        row["damaged"] += int(report.get("damaged") or 0)
        row["suspect"] += int(report.get("suspect") or 0)
        row["exams"] += 1
    books = {}
    for (book, module), row in sorted(rows.items()):
        healthy = row["questions"] - row["damaged"]
        books.setdefault(str(book), {})[module] = {
            "exams": row["exams"],
            "questions": row["questions"],
            "damaged": row["damaged"],
            "suspect": row["suspect"],
            "healthy": healthy,
            "healthPct": round(healthy / row["questions"] * 100, 1) if row["questions"] else None,
        }
    total_q = sum(r["questions"] for r in rows.values())
    total_d = sum(r["damaged"] for r in rows.values())
    total_s = sum(r["suspect"] for r in rows.values())
    return {
        "books": books,
        "totals": {
            "questions": total_q,
            "damaged": total_d,
            "suspect": total_s,
            "healthy": total_q - total_d,
            "healthPct": round((total_q - total_d) / total_q * 100, 1) if total_q else None,
        },
    }


def print_health(health: dict[str, Any]) -> None:
    modules = ("listening", "reading")
    width = 74
    print("")
    print("Cambridge corpus health (healthy/total, ?=needs a human look)")
    print("Book |" + "|".join(f"{m:^26}" for m in modules))
    print("-" * width)
    for book in sorted(health["books"], key=int):
        cells = []
        for module in modules:
            row = health["books"][book].get(module)
            if not row or not row["questions"]:
                cells.append(f"{'-':^26}")
            else:
                cells.append(f"{row['healthy']:>4}/{row['questions']:<4}{row['healthPct']:>6.1f}%  ?{row['suspect']:<4}".ljust(26))
        print(f"C{book:>3} |" + "|".join(cells))
    totals = health["totals"]
    print("-" * width)
    print(f"ALL   {totals['healthy']}/{totals['questions']} healthy ({totals['healthPct']}%) · "
          f"{totals['damaged']} must be repaired · {totals['suspect']} more to review")
    print("")


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
    parser.add_argument("--health", action="store_true", help="print the per-book repair dashboard")
    parser.add_argument(
        "--baseline",
        type=Path,
        nargs="?",
        const=Path("fixtures/cambridge-health-baseline.json"),
        default=None,
        help="ratchet mode: fail only when content damage grows beyond the recorded baseline",
    )
    parser.add_argument("--update-baseline", action="store_true", help="lower the baseline to the current damage count")
    args = parser.parse_args()
    root = args.root.resolve()
    exam_root = root / "fixtures" / "cambridge"
    asset_root = root / "fixtures" / "assets" / "cambridge"
    report_path = (args.report or (root / "data-dev" / "cambridge-qa-report.json")).resolve()
    errors: list[str] = []
    damage: list[str] = []
    warnings: list[str] = []
    seen_ids: dict[str, str] = {}
    exam_reports: list[dict[str, Any]] = []
    files = sorted(exam_root.glob("*.json")) if exam_root.exists() else []
    if not args.partial and len(files) != EXPECTED_EXAMS:
        add(errors, exam_root, f"expected {EXPECTED_EXAMS} exam JSON files, got {len(files)}")
    for path in files:
        result = validate_exam(path, root, errors, damage, warnings, seen_ids)
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
    health = build_health(exam_reports)
    damaged_now = health["totals"]["damaged"]
    baseline_path = (root / args.baseline).resolve() if args.baseline and not args.baseline.is_absolute() else args.baseline
    baseline = None
    if baseline_path is not None:
        if args.update_baseline:
            baseline_path.parent.mkdir(parents=True, exist_ok=True)
            baseline_path.write_text(json.dumps({
                "schemaVersion": 1,
                "note": "Content damage ratchet. Phase 1 lowers this; it must never rise.",
                "damagedQuestions": damaged_now,
                "byBook": health["books"],
            }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            baseline = damaged_now
        elif baseline_path.exists():
            try:
                baseline = int(json.loads(baseline_path.read_text(encoding="utf-8"))["damagedQuestions"])
            except (OSError, ValueError, KeyError, TypeError):
                add(errors, baseline_path, "baseline file is unreadable")
        else:
            add(errors, baseline_path, "baseline file is missing; run with --update-baseline once to record it")
    # Without a baseline every content problem is fatal, as the gate intends.
    if baseline is None:
        errors.extend(damage)
    elif damaged_now > baseline:
        add(errors, exam_root, f"content damage grew from {baseline} to {damaged_now} damaged questions")
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
        "health": health,
        "baseline": baseline,
        "errors": errors,
        "damage": damage,
        "warnings": warnings,
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "ok": report["ok"],
        "examJson": len(files),
        "errors": len(errors),
        "warnings": len(warnings),
        "baseline": baseline,
        "damagedQuestions": damaged_now,
        "suspectQuestions": health["totals"]["suspect"],
        "healthPct": health["totals"]["healthPct"],
        "report": str(report_path),
    }, ensure_ascii=False))
    if args.health:
        print_health(health)
        if baseline is not None:
            trend = "unchanged" if damaged_now == baseline else (f"down {baseline - damaged_now}" if damaged_now < baseline else f"UP {damaged_now - baseline}")
            print(f"Damage ratchet: {damaged_now} vs baseline {baseline} ({trend}). Lower it with --update-baseline.")
            print("")
    if baseline is not None and damaged_now < baseline:
        print(f"NOTE {baseline - damaged_now} questions repaired since the baseline; rerun with --update-baseline to lock it in.", file=sys.stderr)
    if errors:
        for line in errors[:80]:
            print(f"ERROR {line}", file=sys.stderr)
        if len(errors) > 80:
            print(f"... and {len(errors) - 80} more; see {report_path}", file=sys.stderr)
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
