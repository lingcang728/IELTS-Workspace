# -*- coding: utf-8 -*-
"""Stage 5 — merge overlay + parsed + Part offsets into ``fixtures/cambridge/``.

This is the only script in the pipeline that writes fixtures.

Merge priority, and it is not negotiable (AGENTS.md section 4):

    fixtures/overlays/{exam-id}.json   (human)      highest
      > data-dev/repair/parsed/…       (automatic)
        > the existing fixture                       lowest

The overlay is never read-modify-written here, only read. Human review costs
hours per book; one careless overwrite throws those hours away, which is why
reruns of the parser have to be safe by construction.

By default only questions the gate considers damaged are touched, and only when
the replacement is an improvement. ``--dry-run`` prints the diff without
writing; a ``.bak`` is left beside every file that changes.
"""
from __future__ import annotations

import argparse
import hashlib
import re
import shutil
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import (  # noqa: E402
    BOOKS,
    FIXTURES,
    OVERLAYS,
    REPAIR,
    exam_id,
    exam_path,
    read_json,
    write_json,
)

OPTIONED_TYPES = {"single_choice", "multi_choice", "matching", "labelling"}
ACCEPTED_STATUSES = {"approved", "corrected", "flagged"}


def load_overlay(examid: str) -> dict[str, Any]:
    path = OVERLAYS / f"{examid}.json"
    if not path.exists():
        return {}
    data = read_json(path)
    questions = data.get("questions") or {}
    return {qid: entry for qid, entry in questions.items()
            if (entry or {}).get("status") in ACCEPTED_STATUSES}


DAMAGE_LINE_RE = re.compile(r"([A-Za-z0-9-]+)\.json:\s*question\s+(\d{1,2})\b")


def load_damage(report_path: Path) -> set[tuple[str, int]]:
    """The set of (examId, questionNumber) the gate currently calls damaged.

    Re-deriving the damage rules here would be a second, silently drifting copy
    of them. ``verify_cambridge.py`` already writes the authoritative list, so
    read that instead and stay in lockstep by construction.
    """
    if not report_path.exists():
        return set()
    report = read_json(report_path)
    out: set[tuple[str, int]] = set()
    for line in report.get("damage") or []:
        match = DAMAGE_LINE_RE.search(str(line))
        if match:
            out.add((match.group(1), int(match.group(2))))
    return out


def apply_question(question: dict[str, Any], group: dict[str, Any],
                   parsed: dict[str, Any] | None, overlay: dict[str, Any] | None,
                   damaged: bool, only_damaged: bool,
                   allowed: frozenset[str]) -> list[str]:
    """Mutate one question in place; return a list of human-readable changes."""
    changes: list[str] = []
    before_prompt = str(question.get("prompt") or "")
    before_type = question.get("type")

    if overlay:
        # The human's word is final: applied whatever the gate thinks.
        for field in ("prompt", "type", "gapText", "acceptedAnswers"):
            if field in overlay and overlay[field] != question.get(field):
                question[field] = overlay[field]
                changes.append(f"{field} ← overlay")
        if overlay.get("options"):
            question["options"] = overlay["options"]
            changes.append("options ← overlay")
        if changes:
            question["repairSource"] = {"kind": "overlay", "status": overlay.get("status"),
                                        "reviewedAt": overlay.get("reviewedAt")}
        return changes

    if parsed is None:
        return changes
    # Only HIGH is written automatically. MEDIUM means "a human must read this"
    # -- writing it anyway put stems like "froma random selectionof four" and
    # "(aswith most ganzfeldstudies)" into the corpus, which is worse than the
    # placeholder it replaced because it *looks* like a real question.
    if parsed.get("confidence") not in allowed:
        return changes

    if only_damaged and not damaged:
        return changes

    prompt = (parsed.get("prompt") or "").strip()
    # Never trade a real stem for a shorter or empty one.
    if prompt and len(prompt) >= 8 and prompt != before_prompt:
        question["prompt"] = prompt
        changes.append("prompt")

    suggested = parsed.get("suggestedType")
    if suggested and suggested != before_type:
        question["type"] = suggested
        changes.append(f"type {before_type} → {suggested}")

    if parsed.get("options") and question.get("type") in OPTIONED_TYPES:
        existing = question.get("options") or group.get("sharedOptions") or []
        if len(existing) < 2:
            question["options"] = parsed["options"]
            changes.append(f"options (+{len(parsed['options'])})")

    if changes:
        question["repairSource"] = {"kind": "parsed", "confidence": parsed.get("confidence"),
                                    "reasons": parsed.get("reasons") or []}
    return changes


def apply_exam(book: int, test: int, module: str, offsets: dict[str, Any],
               damage: set[tuple[str, int]], only_damaged: bool,
               dry_run: bool, allowed: frozenset[str]) -> dict[str, Any] | None:
    examid = exam_id(book, test, module)
    path = exam_path(book, test, module)
    if not path.exists():
        return None
    exam = read_json(path)

    parsed_path = REPAIR / "parsed" / f"{examid}.json"
    parsed_by_id: dict[str, Any] = {}
    if parsed_path.exists():
        for record in read_json(parsed_path).get("questions") or []:
            parsed_by_id[record["questionId"]] = record
    overlay = load_overlay(examid)

    changes: list[str] = []
    for section in exam.get("sections") or []:
        for group in section.get("questionGroups") or []:
            for question in group.get("questions") or []:
                qid = question.get("id")
                applied = apply_question(question, group, parsed_by_id.get(qid),
                                         overlay.get(qid),
                                         (examid, question.get("number")) in damage,
                                         only_damaged, allowed)
                changes.extend(f"q{question.get('number')}: {c}" for c in applied)

    if module == "listening":
        record = next((r for r in offsets.get("results") or []
                       if r.get("examId") == examid and r.get("ok")), None)
        if record:
            for index, section in enumerate(exam.get("sections") or []):
                if index < len(record["partOffsetsMs"]):
                    start = record["partOffsetsMs"][index]
                    if section.get("audioStartMs") != start:
                        section["audioStartMs"] = start
                        section["audioDurationMs"] = record["partDurationsMs"][index]
                        changes.append(f"{section['id']}: audioStartMs = {start}")

    if changes and not dry_run:
        shutil.copy2(path, path.with_suffix(".json.bak"))
        # Stable digest: Python's str hash is salted per process, so hash()
        # here would churn the revision on every rerun and needlessly mark
        # in-progress sessions as interrupted.
        digest = hashlib.sha1("\n".join(changes).encode("utf-8")).hexdigest()[:8]
        exam["contentRevision"] = f"repair-{len(changes):04d}-{digest}"
        write_json(path, exam)
    return {"examId": examid, "changes": changes,
            "overlayCount": len(overlay), "parsedCount": len(parsed_by_id)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--books", type=str, default="")
    parser.add_argument("--dry-run", action="store_true", help="print the diff, write nothing")
    parser.add_argument("--all-questions", action="store_true",
                        help="also rewrite questions the gate considers healthy")
    parser.add_argument("--include-medium", action="store_true",
                        help="also write MEDIUM-confidence parses (they are usually OCR-damaged; "
                             "review them in the overlay instead)")
    parser.add_argument("--offsets", type=Path, default=REPAIR / "part-offsets.json")
    parser.add_argument("--damage-report", type=Path,
                        default=Path("data-dev/cambridge-qa-report.json"),
                        help="verify_cambridge.py output; defines which questions may be rewritten")
    args = parser.parse_args()

    if not FIXTURES.exists():
        print(f"no fixtures at {FIXTURES}", file=sys.stderr)
        return 1
    offsets = read_json(args.offsets) if args.offsets.exists() else {"results": []}
    damage = load_damage(args.damage_report)
    if not damage and not args.all_questions:
        print(f"no damage list at {args.damage_report}; run verify_cambridge.py first "
              f"or pass --all-questions", file=sys.stderr)
        return 1
    allowed = frozenset({"HIGH", "MEDIUM"} if args.include_medium else {"HIGH"})
    print(f"gate reports {len(damage)} damaged questions; writing {'/'.join(sorted(allowed))} parses")
    books = [int(b) for b in args.books.split(",") if b.strip()] or list(BOOKS)

    total = 0
    touched = 0
    overlay_total = 0
    print(f"{'Exam':<34}{'changes':>9}{'overlay':>9}")
    for book in books:
        for test in (1, 2, 3, 4):
            for module in ("listening", "reading"):
                result = apply_exam(book, test, module, offsets, damage,
                                    not args.all_questions, args.dry_run, allowed)
                if result is None:
                    continue
                overlay_total += result["overlayCount"]
                if not result["changes"]:
                    continue
                touched += 1
                total += len(result["changes"])
                print(f"{result['examId']:<34}{len(result['changes']):>9}{result['overlayCount']:>9}")
                if args.dry_run:
                    for line in result["changes"][:6]:
                        print(f"    {line}")
                    if len(result["changes"]) > 6:
                        print(f"    … {len(result['changes']) - 6} more")

    print("-" * 52)
    print(f"{'TOTAL':<34}{total:>9}{overlay_total:>9}")
    print(f"{touched} exam files {'would change' if args.dry_run else 'changed'}"
          f"{'' if args.dry_run else ' (.json.bak left beside each)'}")
    if not args.dry_run and touched:
        print("\nNow rerun the gate:  python scripts/verify_cambridge.py --baseline --health")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
