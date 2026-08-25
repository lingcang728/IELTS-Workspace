# -*- coding: utf-8 -*-
"""Stage 8a — worklist for the 413 questions whose option list was never extracted.

Correcting the answer keys (stage 6d/7) revealed these. Each one stores a bare
letter as its answer — the printed page offered a choice — but the choices
themselves are missing: no option text anywhere on the question or its group.
The learner sees a stem and nothing to pick from, and the gate counts every one
as damage.

They arrive as 413 single-question groups, which is an importer artefact, not
how the book is laid out: a printed page usually carries several of them at
once. So the tasks are clustered by page, the same way the stem and group
worklists cluster, and a reviewer reads one page and answers everything on it.

What makes this round checkable in a way the earlier option rounds were not:
**the answer key is now trustworthy**, so the submitted option set can be
required to contain the letter the key names. A reviewer who transcribes the
wrong question's options, or invents a shorter list, will not contain the key.

    python scripts/repair/75_option_worklist.py            # render + emit
    python scripts/repair/75_option_worklist.py --status   # counts only
"""
from __future__ import annotations

import argparse
import collections
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "fixtures" / "cambridge"
REPAIR = ROOT / "data-dev" / "repair"
TASKS = REPAIR / "option-tasks"


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


stage50 = _load("stage50", "50_worklist.py")


def missing_option_questions(exam: dict) -> dict[str, list[dict]]:
    """Groups holding a letter-keyed question with no usable options, by group id."""
    out: dict[str, list[dict]] = collections.OrderedDict()
    for section in exam.get("sections") or []:
        for group in section.get("questionGroups") or []:
            shared = group.get("sharedOptions") or []
            for question in group.get("questions") or []:
                answers = [str(a).strip() for a in (question.get("acceptedAnswers") or [])]
                if not answers or not all(len(a) == 1 and a.isalpha() for a in answers):
                    continue
                options = question.get("options") or shared
                if sum(1 for o in options if (o.get("text") or "").strip()) >= 2:
                    continue
                out.setdefault(group.get("id") or "?", []).append({
                    "number": question.get("number"),
                    "prompt": (question.get("prompt") or "")[:160],
                    "answerLetters": sorted({a.upper() for a in answers}),
                    "type": question.get("type"),
                    "instruction": (group.get("instruction") or "")[:120],
                })
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--status", action="store_true")
    parser.add_argument("--book", type=int, default=0)
    args = parser.parse_args()

    page_map = json.loads((REPAIR / "page-map.json").read_text(encoding="utf-8"))["exams"]
    TASKS.mkdir(parents=True, exist_ok=True)
    emitted = questions = 0
    per_book = collections.Counter()

    for path in sorted(FIXTURES.glob("*.json")):
        exam_id = path.stem
        entry = page_map.get(exam_id)
        if entry is None:
            continue
        if args.book and entry.get("book") != args.book:
            continue
        exam = json.loads(path.read_text(encoding="utf-8"))
        by_group = missing_option_questions(exam)
        if not by_group:
            continue

        # One entry per question number, so the page clusterer can group the
        # ones the book printed side by side.
        wanted: dict[int, list[str]] = {}
        owner: dict[int, str] = {}
        detail: dict[int, dict] = {}
        for group_id, items in by_group.items():
            for item in items:
                number = item["number"]
                wanted[number] = ["option list missing"]
                owner[number] = group_id
                detail[number] = item
        all_questions = stage50.load_exam_questions(exam_id)
        for cluster in stage50.group_by_pages(entry["questionPages"], wanted, all_questions):
            pages = list(range(max(0, cluster["lo"] - stage50.PAGE_PAD_BEFORE),
                               cluster["hi"] + stage50.PAGE_PAD_AFTER + 1))
            numbers = sorted(cluster["numbers"])
            task = {
                "schemaVersion": 1,
                "taskId": f"{exam_id}-o{cluster['lo']:04d}",
                "kind": "options",
                "book": entry["book"],
                "examId": exam_id,
                "module": entry["module"],
                "pdf": entry["pdf"],
                "pdfPagesZeroBased": pages,
                "pdfPageNumbers": [p + 1 for p in pages],
                "images": [] if args.status else stage50.render_pages(
                    ROOT / entry["pdf"], pages, stage50.RENDERS / f"C{entry['book']:02d}"),
                "questions": [{**detail[n], "groupId": owner[n]} for n in numbers],
            }
            if not args.status:
                (TASKS / f"{task['taskId']}.task.json").write_text(
                    json.dumps(task, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            emitted += 1
            questions += len(numbers)
            per_book[entry["book"]] += 1

    print(f"{'would emit' if args.status else 'emitted'} {emitted} 工单 · {questions} 题")
    print("按册:", {f"C{b:02d}": n for b, n in sorted(per_book.items())})
    if not args.status:
        print(f"工单 → {TASKS}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
