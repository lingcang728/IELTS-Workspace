# -*- coding: utf-8 -*-
"""Stage 8 — the acceptance gate for a book. Run it before calling a book done.

A book PASSES only when all five checks pass. There is no partial pass, and the
checks are run in order so the first failure names the next thing to fix.

  1. COVERAGE   every damaged question in the book has an overlay entry
  2. VALIDITY   every overlay entry still satisfies the stage-7 rules
                (re-checked here, because an overlay file can be hand-edited)
  3. APPLIED    40_apply.py has been run since the overlay last changed
  4. GATE       verify_cambridge.py reports fewer damaged questions than the
                recorded baseline, and zero structural errors
  5. FLAGGED    the share of questions parked as `flagged` is under the cap

Nothing here writes to the corpus. It reports, and it exits non-zero on failure
so a runner script can stop.

    python scripts/repair/80_audit.py --book 8
    python scripts/repair/80_audit.py --all
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import BOOKS, FIXTURES, OVERLAYS, REPAIR, ROOT, read_json  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
import importlib.util

_spec = importlib.util.spec_from_file_location(
    "stage70", Path(__file__).resolve().parent / "70_write_overlay.py")
stage70 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(stage70)

DAMAGE_LINE_RE = re.compile(r"([A-Za-z0-9-]+)\.json:\s*question\s+(\d{1,2})\b")
# Above this share of `flagged` questions the book has not really been done,
# it has been deferred.
MAX_FLAGGED_SHARE = 0.05


def gate(extra: list[str]) -> dict[str, Any]:
    """Run verify_cambridge.py and return its JSON report."""
    command = [sys.executable, str(ROOT / "scripts" / "verify_cambridge.py"),
               "--skip-audio", "--baseline", *extra]
    subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=1800)
    return read_json(ROOT / "data-dev" / "cambridge-qa-report.json")


def damaged_by_exam(report: dict[str, Any]) -> dict[str, set[int]]:
    out: dict[str, set[int]] = {}
    for line in report.get("damage") or []:
        match = DAMAGE_LINE_RE.search(str(line))
        if match:
            out.setdefault(match.group(1), set()).add(int(match.group(2)))
    return out


def exam_ids(book: int) -> list[str]:
    return sorted(p.stem for p in FIXTURES.glob(f"cambridge-{book}-test-*-*.json")
                  if not p.stem.endswith("writing"))


def audit_book(book: int, report: dict[str, Any], baseline: dict[str, Any]) -> dict[str, Any]:
    failures: list[str] = []
    notes: list[str] = []
    damaged = damaged_by_exam(report)

    # ---------------------------------------------------------- 1. COVERAGE
    uncovered: list[str] = []
    flagged = 0
    reviewed = 0
    for exam_id in exam_ids(book):
        overlay_path = OVERLAYS / f"{exam_id}.json"
        entries = (read_json(overlay_path).get("questions") or {}) if overlay_path.exists() else {}
        exam = read_json(FIXTURES / f"{exam_id}.json")
        by_number = {
            q["number"]: q["id"]
            for section in exam.get("sections") or []
            for group in section.get("questionGroups") or []
            for q in group.get("questions") or []
            if isinstance(q.get("number"), int)
        }
        for number in sorted(damaged.get(exam_id, set())):
            qid = by_number.get(number)
            if qid not in entries:
                uncovered.append(f"{exam_id} q{number}")
        for entry in entries.values():
            reviewed += 1
            if (entry or {}).get("status") == "flagged":
                flagged += 1
    if uncovered:
        failures.append(f"COVERAGE: {len(uncovered)} damaged question(s) have no overlay entry, "
                        f"e.g. {uncovered[:5]}")
    else:
        notes.append(f"COVERAGE ok: every damaged question in C{book:02d} has an overlay entry")

    # ---------------------------------------------------------- 2. VALIDITY
    invalid: list[str] = []
    for exam_id in exam_ids(book):
        overlay_path = OVERLAYS / f"{exam_id}.json"
        if not overlay_path.exists():
            continue
        for qid, entry in (read_json(overlay_path).get("questions") or {}).items():
            entry = entry or {}
            status = entry.get("status")
            if status not in stage70.VALID_STATUS:
                invalid.append(f"{qid}: bad status {status!r}")
                continue
            if status == "flagged":
                if len(str(entry.get("note") or "")) < 10:
                    invalid.append(f"{qid}: flagged without a usable note")
                continue
            errors: list[str] = []
            qtype = entry.get("type")
            if qtype not in stage70.VALID_TYPES:
                errors.append(f"bad type {qtype!r}")
            options = entry.get("options") or []
            stage70.check_prompt(str(entry.get("prompt") or ""), "", qtype or "", qid, errors)
            stage70.check_answers(entry.get("acceptedAnswers") or [], qtype or "", options, qid, errors)
            invalid.extend(errors)
    if invalid:
        failures.append(f"VALIDITY: {len(invalid)} overlay entrie(s) would not pass stage 7, "
                        f"e.g. {invalid[:4]}")
    else:
        notes.append("VALIDITY ok: every overlay entry still satisfies the stage-7 rules")

    # ----------------------------------------------------------- 3. APPLIED
    stale: list[str] = []
    for exam_id in exam_ids(book):
        overlay_path = OVERLAYS / f"{exam_id}.json"
        fixture_path = FIXTURES / f"{exam_id}.json"
        if overlay_path.exists() and fixture_path.exists():
            if overlay_path.stat().st_mtime > fixture_path.stat().st_mtime + 1:
                stale.append(exam_id)
    if stale:
        failures.append(f"APPLIED: overlay is newer than the fixture for {stale[:4]} — "
                        f"run `python scripts/repair/40_apply.py --books {book}`")
    else:
        notes.append("APPLIED ok: fixtures are at least as new as their overlays")

    # -------------------------------------------------------------- 4. GATE
    if report.get("errors"):
        failures.append(f"GATE: {len(report['errors'])} structural error(s) — see the report")
    book_now = sum(len(v) for exam_id, v in damaged.items()
                   if exam_id.startswith(f"cambridge-{book}-test-"))
    base_rows = (baseline.get("byBook") or {}).get(str(book)) or {}
    book_base = sum(int(row.get("damaged") or 0) for row in base_rows.values())
    if book_now > book_base:
        failures.append(f"GATE: damage in C{book:02d} rose from {book_base} to {book_now}")
    else:
        notes.append(f"GATE ok: C{book:02d} damage {book_base} → {book_now} "
                     f"({book_base - book_now} repaired)")

    # ----------------------------------------------------------- 5. FLAGGED
    share = flagged / reviewed if reviewed else 0.0
    if share > MAX_FLAGGED_SHARE:
        failures.append(f"FLAGGED: {flagged}/{reviewed} ({share:.0%}) parked as flagged, "
                        f"cap is {MAX_FLAGGED_SHARE:.0%}. Re-read those pages instead of deferring.")
    else:
        notes.append(f"FLAGGED ok: {flagged}/{reviewed} ({share:.0%}) flagged")

    return {"book": book, "pass": not failures, "failures": failures, "notes": notes,
            "damagedNow": book_now, "damagedBaseline": book_base,
            "reviewed": reviewed, "flagged": flagged}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--book", type=int)
    parser.add_argument("--books", type=str, default="")
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    args = parser.parse_args()

    if args.all:
        books = list(BOOKS)
    elif args.book:
        books = [args.book]
    else:
        books = [int(b) for b in args.books.split(",") if b.strip()]
    if not books:
        print("give --book N, --books a,b or --all", file=sys.stderr)
        return 2

    report = gate([])
    baseline_path = ROOT / "fixtures" / "cambridge-health-baseline.json"
    baseline = read_json(baseline_path) if baseline_path.exists() else {}

    results = [audit_book(book, report, baseline) for book in books]
    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    else:
        for result in results:
            verdict = "PASS" if result["pass"] else "FAIL"
            print(f"\n=== C{result['book']:02d}  {verdict} ===")
            for note in result["notes"]:
                print(f"  ok   {note}")
            for failure in result["failures"]:
                print(f"  FAIL {failure}")
        passed = sum(1 for r in results if r["pass"])
        print(f"\n{passed}/{len(results)} book(s) pass")
    return 0 if all(r["pass"] for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
