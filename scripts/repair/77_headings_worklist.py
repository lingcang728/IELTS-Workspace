# -*- coding: utf-8 -*-
"""Stage 9a — worklist for List of Headings groups that lost their headings.

176 questions answer with a roman numeral — `iv`, `viii` — which is how
Cambridge numbers a List of Headings box. The box itself was never extracted,
so the learner is asked to choose a heading and shown nothing to choose from.

Unlike the option round, these are not per-question lists. A passage prints
**one** box of headings and every heading question in that passage picks from
it, so the tasks are one per passage: the reviewer transcribes a single
`i`-`viii` list that answers 8 or 10 questions at once. That collapses 176
questions into far fewer reads.

The check that makes this round self-verifying is the same one the corrected
answer keys bought us: the transcribed list must contain **every roman numeral
the passage's answer key uses**. A list that stops at `vi` cannot be right for
a passage whose key names `viii`.

    python scripts/repair/77_headings_worklist.py            # render + emit
    python scripts/repair/77_headings_worklist.py --status   # counts only
"""
from __future__ import annotations

import argparse
import collections
import importlib.util
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "fixtures" / "cambridge"
REPAIR = ROOT / "data-dev" / "repair"
TASKS = REPAIR / "headings-tasks"

ROMAN = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii"]
ROMAN_SET = set(ROMAN)
# The rubric is what makes a group a List of Headings group, not the shape of
# its answer key.
HEADING_RUBRIC_RE = re.compile(r"\bheadings?\b", re.I)


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


stage50 = _load("stage50", "50_worklist.py")


def heading_groups(exam: dict) -> list[dict]:
    """Every group whose key is roman and whose headings box is missing."""
    found: list[dict] = []
    for section in exam.get("sections") or []:
        for group in section.get("questionGroups") or []:
            # `i`, `v` and `x` are also perfectly good Latin option labels, and
            # OCR junk keys land on them too. Reading a key as a roman numeral
            # without checking the rubric is what put 16 note-completion and
            # summary tasks into the first run of this worklist — a reviewer
            # opened the page, found no headings box, and rightly refused.
            # Only a group that says "heading" is a List of Headings group.
            if not HEADING_RUBRIC_RE.search(group.get("instruction") or ""):
                continue
            numbers, keys = [], set()
            for question in group.get("questions") or []:
                answers = [str(a).strip() for a in (question.get("acceptedAnswers") or [])]
                if answers and all(a.lower() in ROMAN_SET for a in answers):
                    numbers.append(question.get("number"))
                    keys |= {a.lower() for a in answers}
            if not numbers:
                continue
            shared = group.get("sharedOptions") or []
            if sum(1 for o in shared if (o.get("text") or "").strip()) >= 2:
                continue
            found.append({
                "sectionId": section.get("id"),
                "groupId": group.get("id"),
                "numbers": sorted(numbers),
                "romanKeys": sorted(keys, key=ROMAN.index),
                "instruction": (group.get("instruction") or "")[:140],
            })
    return found


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--status", action="store_true")
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
        exam = json.loads(path.read_text(encoding="utf-8"))
        groups = heading_groups(exam)
        if not groups:
            continue

        # One task per passage: the printed headings box is shared by every
        # heading question in that passage, so asking per question would make a
        # reviewer transcribe the same list eight times.
        by_section: dict[str, list[dict]] = collections.OrderedDict()
        for record in groups:
            by_section.setdefault(record["sectionId"], []).append(record)

        all_questions = stage50.load_exam_questions(exam_id)
        for section_id, records in by_section.items():
            numbers = sorted(n for r in records for n in r["numbers"])
            keys = sorted({k for r in records for k in r["romanKeys"]}, key=ROMAN.index)
            wanted = {n: ["headings box missing"] for n in numbers}
            clusters = stage50.group_by_pages(entry["questionPages"], wanted, all_questions)
            lo = min(c["lo"] for c in clusters) if clusters else 0
            hi = max(c["hi"] for c in clusters) if clusters else 0
            pages = list(range(max(0, lo - stage50.PAGE_PAD_BEFORE),
                               hi + stage50.PAGE_PAD_AFTER + 1))
            task = {
                "schemaVersion": 1,
                "taskId": f"{exam_id}-h-{section_id}",
                "kind": "headings",
                "book": entry["book"],
                "examId": exam_id,
                "sectionId": section_id,
                "pdf": entry["pdf"],
                "pdfPagesZeroBased": pages,
                "pdfPageNumbers": [p + 1 for p in pages],
                "images": [] if args.status else stage50.render_pages(
                    ROOT / entry["pdf"], pages, stage50.RENDERS / f"C{entry['book']:02d}"),
                "questionNumbers": numbers,
                # Every numeral the key uses. The submitted box must contain all
                # of them, which is what stops a short or misread list.
                "romanKeysUsed": keys,
                "groups": [{"groupId": r["groupId"], "numbers": r["numbers"],
                            "romanKeys": r["romanKeys"]} for r in records],
                "instruction": records[0]["instruction"],
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
