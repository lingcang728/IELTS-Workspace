# -*- coding: utf-8 -*-
"""Stage 6 — build the proofreading worklist and render its pages.

The executing model is not trusted to decide *what* to work on, only to read a
page image and transcribe it. This script makes that decision: it reads the
gate's damage list, groups the damaged questions by the PDF page window they
were printed on, and writes one self-contained task file per page group,
alongside the rendered PNGs.

A task file carries everything the reader needs and nothing it has to look up:
the exam id, the page images, and for every damaged question its number, its
current (broken) prompt, its accepted answers, and why the gate flagged it.

Tasks are deterministic and idempotent: rerunning regenerates the same task ids
and skips whatever is already answered, so a run can be interrupted at any
point and resumed.

    python scripts/repair/50_worklist.py --book 8            # build + render
    python scripts/repair/50_worklist.py --book 8 --status   # progress only
    python scripts/repair/50_worklist.py --book 8 --next 1   # the next task only
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import BOOKS, OVERLAYS, REPAIR, ROOT, read_json, write_json  # noqa: E402

TASKS = REPAIR / "tasks"
RENDERS = REPAIR / "renders"
DAMAGE_LINE_RE = re.compile(r"([A-Za-z0-9-]+)\.json:\s*question\s+(\d{1,2})\s+(.*)")
QID_NUM_RE = re.compile(r"q(\d+)$")
# 120 DPI grayscale JPEG: verified legible on scanned Cambridge pages down to
# the dotted gap markers, at ~0.6 MB/page instead of ~2 MB for colour PNG.
RENDER_DPI = 120
RENDER_QUALITY = 72
# One task may not span more pages than this; a reader that is handed six pages
# at once starts skimming.
MAX_PAGES_PER_TASK = 3


def load_damage(report_path: Path) -> dict[str, dict[int, list[str]]]:
    if not report_path.exists():
        raise SystemExit(f"no gate report at {report_path}; run verify_cambridge.py first")
    report = read_json(report_path)
    out: dict[str, dict[int, list[str]]] = {}
    for line in report.get("damage") or []:
        match = DAMAGE_LINE_RE.search(str(line))
        if not match:
            continue
        out.setdefault(match.group(1), {}).setdefault(int(match.group(2)), []).append(match.group(3))
    return out


def load_exam_questions(exam_id: str) -> dict[int, dict[str, Any]]:
    path = ROOT / "fixtures" / "cambridge" / f"{exam_id}.json"
    if not path.exists():
        return {}
    exam = read_json(path)
    out: dict[int, dict[str, Any]] = {}
    for section in exam.get("sections") or []:
        for group in section.get("questionGroups") or []:
            for question in group.get("questions") or []:
                number = question.get("number")
                if isinstance(number, int):
                    out[number] = {
                        "questionId": question.get("id"),
                        "number": number,
                        "currentPrompt": question.get("prompt"),
                        "currentType": question.get("type"),
                        "groupType": group.get("questionType"),
                        "groupInstruction": group.get("instruction"),
                        "acceptedAnswers": question.get("acceptedAnswers") or [],
                        "hasOptions": len(question.get("options") or group.get("sharedOptions") or []),
                    }
    return out


def group_by_pages(page_map: dict[str, Any], damaged: dict[int, list[str]],
                   questions: dict[int, dict[str, Any]]) -> list[dict[str, Any]]:
    """Cluster damaged questions into page windows, merging overlaps."""
    entries: list[tuple[int, int, int]] = []  # (lo, hi, number)
    for number in sorted(damaged):
        qid = (questions.get(number) or {}).get("questionId")
        bounds = page_map.get(qid) if qid else None
        if not bounds:
            continue
        entries.append((int(bounds[0]), int(bounds[1]), number))
    if not entries:
        return []
    entries.sort()

    clusters: list[dict[str, Any]] = []
    current = {"lo": entries[0][0], "hi": entries[0][1], "numbers": [entries[0][2]]}
    for lo, hi, number in entries[1:]:
        merged_lo, merged_hi = min(current["lo"], lo), max(current["hi"], hi)
        overlaps = lo <= current["hi"]
        if overlaps and (merged_hi - merged_lo + 1) <= MAX_PAGES_PER_TASK:
            current["lo"], current["hi"] = merged_lo, merged_hi
            current["numbers"].append(number)
        else:
            clusters.append(current)
            current = {"lo": lo, "hi": hi, "numbers": [number]}
    clusters.append(current)
    return clusters


def render_pages(pdf: Path, pages: list[int], out_dir: Path) -> list[str]:
    import fitz  # PyMuPDF; imported late so --status works without it

    out_dir.mkdir(parents=True, exist_ok=True)
    document = fitz.open(pdf)
    written: list[str] = []
    for page_index in pages:
        if page_index < 0 or page_index >= document.page_count:
            continue
        target = out_dir / f"p{page_index:04d}.jpg"
        if not target.exists():
            pixmap = document[page_index].get_pixmap(dpi=RENDER_DPI, colorspace=fitz.csGRAY)
            pixmap.pil_save(target, format="JPEG", quality=RENDER_QUALITY, optimize=True)
        written.append(str(target.relative_to(ROOT)).replace("\\", "/"))
    document.close()
    return written


def overlay_done(exam_id: str) -> set[str]:
    path = OVERLAYS / f"{exam_id}.json"
    if not path.exists():
        return set()
    data = read_json(path)
    return {qid for qid, entry in (data.get("questions") or {}).items()
            if (entry or {}).get("status") in {"approved", "corrected", "flagged"}}


def build_book(book: int, page_map: dict[str, Any], damage: dict[str, dict[int, list[str]]],
               render: bool) -> list[dict[str, Any]]:
    tasks: list[dict[str, Any]] = []
    exams = sorted(exam_id for exam_id, entry in page_map["exams"].items()
                   if entry["book"] == book)
    for exam_id in exams:
        entry = page_map["exams"][exam_id]
        damaged = damage.get(exam_id) or {}
        if not damaged:
            continue
        questions = load_exam_questions(exam_id)
        done = overlay_done(exam_id)
        for cluster in group_by_pages(entry["questionPages"], damaged, questions):
            pages = list(range(cluster["lo"], cluster["hi"] + 1))
            task_id = f"{exam_id}-p{cluster['lo']:04d}"
            payload = {
                "schemaVersion": 1,
                "taskId": task_id,
                "book": book,
                "examId": exam_id,
                "module": entry["module"],
                "test": entry["test"],
                "pdf": entry["pdf"],
                "pdfPagesZeroBased": pages,
                # 1-based position in the PDF file. NOT the page number printed
                # in the book: Cambridge front matter offsets them by ~9.
                "pdfPageNumbers": [p + 1 for p in pages],
                "images": [],
                "questions": [],
            }
            for number in cluster["numbers"]:
                record = dict(questions.get(number) or {"number": number})
                record["damageReasons"] = damaged.get(number) or []
                record["alreadyReviewed"] = record.get("questionId") in done
                payload["questions"].append(record)
            payload["remaining"] = sum(1 for q in payload["questions"] if not q["alreadyReviewed"])
            if render and payload["remaining"]:
                payload["images"] = render_pages(ROOT / entry["pdf"], pages, RENDERS / f"C{book:02d}")
            tasks.append(payload)
    return tasks


def expand_task(task_id: str, by: int) -> int:
    """Widen one task's page window and re-render.

    The page estimate is exact for ~94% of questions; for the rest the printed
    "Questions a-b" heading sits a page or two outside the window and the
    stage-7 heading check correctly refuses the submission. This is the only
    sanctioned way out of that: widen and look again. It is never a reason to
    guess, and never a reason to mark the questions `flagged`.
    """
    hits = list(TASKS.glob(f"*/{task_id}.task.json"))
    if not hits:
        print(f"no task file for {task_id!r}", file=sys.stderr)
        return 2
    path = hits[0]
    task = read_json(path)
    low = max(0, min(task["pdfPagesZeroBased"]) - by)
    high = max(task["pdfPagesZeroBased"]) + by
    pages = list(range(low, high + 1))
    task["pdfPagesZeroBased"] = pages
    task["pdfPageNumbers"] = [p + 1 for p in pages]
    task["expandedBy"] = task.get("expandedBy", 0) + by
    task["images"] = render_pages(ROOT / task["pdf"], pages, RENDERS / f"C{task['book']:02d}")
    write_json(path, task)
    print(json.dumps({"ok": True, "taskId": task_id, "pdfPageNumbers": task["pdfPageNumbers"],
                      "images": task["images"], "expandedBy": task["expandedBy"]},
                     ensure_ascii=False))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--book", type=int, help="single book, e.g. 8")
    parser.add_argument("--books", type=str, default="", help="e.g. 4,5,6")
    parser.add_argument("--page-map", type=Path, default=REPAIR / "page-map.json")
    parser.add_argument("--damage-report", type=Path, default=ROOT / "data-dev" / "cambridge-qa-report.json")
    parser.add_argument("--status", action="store_true", help="print progress, build nothing")
    parser.add_argument("--next", type=int, default=0, help="print the next N unfinished task ids and stop")
    parser.add_argument("--no-render", action="store_true", help="build task files without rendering images")
    parser.add_argument("--expand", type=str, default="",
                        help="widen one task's page window and re-render, e.g. --expand <taskId>")
    parser.add_argument("--by", type=int, default=2, help="pages to add on each side of --expand")
    args = parser.parse_args()

    if args.expand:
        return expand_task(args.expand, max(1, args.by))

    books = [args.book] if args.book else [int(b) for b in args.books.split(",") if b.strip()] or list(BOOKS)
    page_map = read_json(args.page_map)
    damage = load_damage(args.damage_report)

    grand = {"tasks": 0, "questions": 0, "remaining": 0, "pages": 0}
    for book in books:
        tasks = build_book(book, page_map, damage, render=not (args.status or args.no_render))
        pages = {(book, p) for t in tasks for p in t["pdfPagesZeroBased"]}
        remaining = sum(t["remaining"] for t in tasks)
        questions = sum(len(t["questions"]) for t in tasks)
        grand["tasks"] += len(tasks)
        grand["questions"] += questions
        grand["remaining"] += remaining
        grand["pages"] += len(pages)
        if not args.status:
            for task in tasks:
                write_json(TASKS / f"C{book:02d}" / f"{task['taskId']}.task.json", task)
        print(f"C{book:02d}  {len(tasks):>4} tasks  {len(pages):>4} pages  "
              f"{questions - remaining:>4}/{questions} questions reviewed")
        if args.next:
            for task in [t for t in tasks if t["remaining"]][:args.next]:
                print(f"  NEXT {task['taskId']}  pdf pages {task['pdfPageNumbers']}  "
                      f"{task['remaining']} questions")

    print("-" * 62)
    print(f"TOTAL {grand['tasks']} tasks · {grand['pages']} page renders · "
          f"{grand['questions'] - grand['remaining']}/{grand['questions']} questions reviewed")
    if not args.status:
        print(f"tasks  → {TASKS}")
        print(f"images → {RENDERS}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
