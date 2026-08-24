# -*- coding: utf-8 -*-
"""Stage 10 — worklist for the content gaps that only the printed page can fill.

Stage 9 recovered every rubric that matched a canonical template. What is left
is the residue that cannot be recognised, plus the option lists whose text the
extraction dropped:

  * a group whose rubric no template matched, or that has no "Questions a-b"
    heading in the markdown at all
  * a group whose option labels (A, B, C ...) survived but whose option *text*
    did not, so the app renders a row of blank buttons

Both are printed on the same page as the questions, so they cluster onto the
same page images stage 6 already renders. This script groups them by page
window and writes one task file per cluster, exactly like `50_worklist.py`
does for stems -- same task-id scheme, same resume behaviour, same rule that
a task is answered all at once or not at all.

    python scripts/repair/62_group_worklist.py --book 8
    python scripts/repair/62_group_worklist.py --book 8 --status
    python scripts/repair/62_group_worklist.py --book 8 --next 1
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import importlib.util  # noqa: E402

from common import BOOKS, FIXTURES, OVERLAYS, REPAIR, ROOT, read_json, write_json  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "stage50", Path(__file__).resolve().parent / "50_worklist.py")
stage50 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(stage50)

TASKS = REPAIR / "group-tasks"
GAP_LINE_RE = re.compile(r"([A-Za-z0-9-]+)\.json:\s*(group|question)\s+(\S+)\s+(.*)")


def load_gaps(report_path: Path) -> dict[str, dict[str, list[str]]]:
    """{exam id: {group id or question number: [reasons]}} from the gate."""
    if not report_path.exists():
        raise SystemExit(f"no gate report at {report_path}; run verify_cambridge.py first")
    out: dict[str, dict[str, list[str]]] = {}
    for line in read_json(report_path).get("gaps") or []:
        match = GAP_LINE_RE.search(str(line))
        if not match:
            continue
        exam, kind, key, reason = match.groups()
        # Passage and writing-prompt gaps are a re-segmentation job, not a
        # page-reading one; they are excluded here on purpose.
        if kind == "group" or "every option is blank" in reason:
            out.setdefault(exam, {}).setdefault(key, []).append(reason)
    return out


def group_index(exam: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Everything a reader needs about each group, keyed by group id."""
    out: dict[str, dict[str, Any]] = {}
    for section in exam.get("sections") or []:
        for group in section.get("questionGroups") or []:
            numbers = [q["number"] for q in (group.get("questions") or [])
                       if isinstance(q.get("number"), int)]
            if not numbers:
                continue
            shared = group.get("sharedOptions") or []
            out[str(group.get("id"))] = {
                "groupId": group.get("id"),
                "numbers": numbers,
                "currentInstruction": group.get("instruction"),
                "questionType": group.get("questionType"),
                "optionLabels": [str(o.get("label") or o.get("id")) for o in shared],
                "optionTextPresent": sum(1 for o in shared if str(o.get("text") or "").strip()),
                "stems": [{"number": q["number"], "prompt": q.get("prompt"),
                           "acceptedAnswers": q.get("acceptedAnswers") or []}
                          for q in (group.get("questions") or [])][:12],
            }
    return out


def normalise_keys(pending: dict[str, list[str]],
                   groups: dict[str, dict[str, Any]]) -> dict[str, list[str]]:
    """Fold question-number gaps onto the group that owns them.

    The gate reports a lost option list twice: once per group ("carries 8
    option labels with no text") and once per affected question ("answer is
    option ['D'] but every option is blank"). Both are repaired by
    transcribing the same printed box, so they must land on one task entry --
    otherwise a bare question number becomes a group with no fields.
    """
    owner = {number: gid for gid, group in groups.items() for number in group["numbers"]}
    folded: dict[str, list[str]] = {}
    for key, reasons in pending.items():
        gid = key
        if key not in groups and key.isdigit():
            gid = owner.get(int(key), key)
        folded.setdefault(gid, []).extend(reasons)
    return {gid: sorted(set(reasons)) for gid, reasons in folded.items()}


def numbers_for_key(key: str, groups: dict[str, dict[str, Any]]) -> list[int]:
    if key in groups:
        return groups[key]["numbers"]
    if key.isdigit():
        return [int(key)]
    return []


def overlay_done_groups(exam_id: str) -> set[str]:
    path = OVERLAYS / f"{exam_id}.json"
    if not path.exists():
        return set()
    data = read_json(path)
    return {gid for gid, entry in (data.get("groups") or {}).items()
            if (entry or {}).get("status") in {"approved", "corrected", "flagged"}}


def build_book(book: int, page_map: dict[str, Any], gaps: dict[str, dict[str, list[str]]],
               render: bool) -> list[dict[str, Any]]:
    tasks: list[dict[str, Any]] = []
    exams = sorted(exam_id for exam_id, entry in page_map["exams"].items()
                   if entry["book"] == book)
    for exam_id in exams:
        entry = page_map["exams"][exam_id]
        pending = gaps.get(exam_id) or {}
        if not pending:
            continue
        exam_path = FIXTURES / f"{exam_id}.json"
        if not exam_path.exists():
            continue
        exam = read_json(exam_path)
        groups = group_index(exam)
        pending = normalise_keys(pending, groups)
        done = overlay_done_groups(exam_id)
        questions = stage50.load_exam_questions(exam_id)

        # Reuse the stem worklist's page clustering by expressing each gap as
        # the question numbers it covers.
        damaged: dict[int, list[str]] = {}
        owner: dict[int, str] = {}
        for key, reasons in pending.items():
            for number in numbers_for_key(key, groups):
                damaged.setdefault(number, []).extend(reasons)
                owner[number] = key
        if not damaged:
            continue

        for cluster in stage50.group_by_pages(entry["questionPages"], damaged, questions):
            pages = list(range(max(0, cluster["lo"] - stage50.PAGE_PAD_BEFORE),
                               cluster["hi"] + stage50.PAGE_PAD_AFTER + 1))
            keys: list[str] = []
            for number in cluster["numbers"]:
                key = owner.get(number)
                if key and key not in keys:
                    keys.append(key)
            payload = {
                "schemaVersion": 1,
                "taskId": f"{exam_id}-g{cluster['lo']:04d}",
                "kind": "group",
                "book": book,
                "examId": exam_id,
                "module": entry["module"],
                "test": entry["test"],
                "pdf": entry["pdf"],
                "pdfPagesZeroBased": pages,
                "pdfPageNumbers": [p + 1 for p in pages],
                "images": [],
                "groups": [],
            }
            for key in keys:
                record = dict(groups.get(key) or {"groupId": key,
                                                  "numbers": numbers_for_key(key, groups)})
                record["gapReasons"] = sorted({r for n in record.get("numbers", [])
                                               for r in damaged.get(n, [])})
                record["alreadyReviewed"] = key in done
                payload["groups"].append(record)
            payload["remaining"] = sum(1 for g in payload["groups"] if not g["alreadyReviewed"])
            if render and payload["remaining"]:
                payload["images"] = stage50.render_pages(
                    ROOT / entry["pdf"], pages, stage50.RENDERS / f"C{book:02d}")
            tasks.append(payload)
    return tasks


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--book", type=int)
    parser.add_argument("--books", type=str, default="")
    parser.add_argument("--page-map", type=Path, default=REPAIR / "page-map.json")
    parser.add_argument("--gap-report", type=Path,
                        default=ROOT / "data-dev" / "cambridge-qa-report.json")
    parser.add_argument("--status", action="store_true")
    parser.add_argument("--next", type=int, default=0)
    parser.add_argument("--no-render", action="store_true")
    args = parser.parse_args()

    books = [args.book] if args.book else \
        [int(b) for b in args.books.split(",") if b.strip()] or list(BOOKS)
    page_map = read_json(args.page_map)
    gaps = load_gaps(args.gap_report)

    grand = {"tasks": 0, "groups": 0, "remaining": 0, "pages": 0}
    for book in books:
        tasks = build_book(book, page_map, gaps, render=not (args.status or args.no_render))
        pages = {(book, p) for t in tasks for p in t["pdfPagesZeroBased"]}
        remaining = sum(t["remaining"] for t in tasks)
        total = sum(len(t["groups"]) for t in tasks)
        grand["tasks"] += len(tasks)
        grand["groups"] += total
        grand["remaining"] += remaining
        grand["pages"] += len(pages)
        if not args.status:
            for task in tasks:
                write_json(TASKS / f"C{book:02d}" / f"{task['taskId']}.task.json", task)
        print(f"C{book:02d}  {len(tasks):>4} tasks  {len(pages):>4} pages  "
              f"{total - remaining:>4}/{total} groups reviewed")
        if args.next:
            for task in [t for t in tasks if t["remaining"]][:args.next]:
                print(f"  NEXT {task['taskId']}  pdf pages {task['pdfPageNumbers']}  "
                      f"{task['remaining']} groups")

    print("-" * 62)
    print(f"TOTAL {grand['tasks']} tasks · {grand['pages']} page renders · "
          f"{grand['groups'] - grand['remaining']}/{grand['groups']} groups reviewed")
    if not args.status:
        print(f"tasks  → {TASKS}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
