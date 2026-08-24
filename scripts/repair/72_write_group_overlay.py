# -*- coding: utf-8 -*-
"""Stage 11 — the enforcement layer for group-level submissions.

Same contract as `70_write_overlay.py`, one level up: the reader is handed a
page image and transcribes the *rubric* and the *option list* printed on it,
and this script decides whether that submission is admissible. A task is
accepted whole or rejected whole -- there is no partial credit, and a rejected
submission writes nothing.

What it refuses
---------------
  * a submission for a different task, or one that skips groups in the task
  * a `printedPageNumber` inconsistent with the offset this book has already
    established (the number printed in the book is not the PDF page index)
  * `questionsHeadingSeen` that does not cover every question in the task --
    a reader who did not look at the page cannot produce these
  * a rubric that is still the placeholder, is unchanged from the broken
    original (unless the status is `approved`), or that cites a reading
    passage inside a listening paper
  * an option list that does not cover every letter the answer key uses, or
    that leaves any option without text -- the defect being repaired

    python scripts/repair/72_write_group_overlay.py --task <taskId> --check-only
    python scripts/repair/72_write_group_overlay.py --task <taskId>
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import FIXTURES, OVERLAYS, REPAIR, ROOT, read_json, write_json  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "stage70", Path(__file__).resolve().parent / "70_write_overlay.py")
stage70 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(stage70)

fail = stage70.fail
heading_numbers = stage70.heading_numbers
BAD_CHARS_RE = stage70.BAD_CHARS_RE

TASKS = REPAIR / "group-tasks"
VALID_STATUS = {"corrected", "approved", "flagged"}
PLACEHOLDER_RE = re.compile(r"write the answer from the source|^\s*(todo|placeholder|n/a|-)\s*$", re.I)
CROSS_MODULE_RE = re.compile(r"reading passage|from the passage|which paragraph|"
                             r"on your answer sheet", re.I)
# A rubric is one or two short sentences. Anything longer is body text that the
# reader has scooped up along with it.
MAX_INSTRUCTION = 220
MIN_INSTRUCTION = 12
MAX_OPTION_TEXT = 220
# Every IELTS rubric starts with one of these verbs.
INSTRUCTION_OPENER_RE = re.compile(
    r"^(complete|choose|write|do the following|which|label|answer|match|classify|"
    r"look at|reading passage|the text)", re.I)


def check_instruction(text: Any, current: str, module: str, where: str,
                      errors: list[str], allow_unchanged: bool) -> str:
    if not isinstance(text, str) or not text.strip():
        fail(errors, where, "instruction is empty")
        return ""
    value = " ".join(text.split())
    if len(value) < MIN_INSTRUCTION:
        fail(errors, where, f"instruction is only {len(value)} characters: {value!r}")
    if len(value) > MAX_INSTRUCTION:
        fail(errors, where, f"instruction is {len(value)} characters; a rubric is one or two "
                            f"short sentences, not the question body")
    if PLACEHOLDER_RE.search(value):
        fail(errors, where, f"instruction is still a placeholder: {value!r}")
    if BAD_CHARS_RE.search(value):
        fail(errors, where, "instruction contains OCR junk (CJK / tick marks / control chars)")
    if not INSTRUCTION_OPENER_RE.match(value):
        fail(errors, where, f"instruction does not begin like an IELTS rubric: {value[:60]!r}")
    if module == "listening" and CROSS_MODULE_RE.search(value):
        fail(errors, where, f"this is a listening paper but the instruction cites a reading "
                            f"passage / answer sheet: {value[:60]!r}")
    if current and value == current.strip() and not allow_unchanged:
        fail(errors, where, "instruction is unchanged from the broken original; if the rubric "
                            "printed on the page really is this text, use status 'approved'")
    return value


def check_option_list(options: Any, labels_expected: list[str], answers_used: set[str],
                      where: str, errors: list[str]) -> list[dict[str, Any]]:
    if not isinstance(options, list) or len(options) < 2:
        fail(errors, where, f"needs at least two options, got {options!r}")
        return []
    out: list[dict[str, Any]] = []
    seen_labels: set[str] = set()
    seen_text: set[str] = set()
    for index, option in enumerate(options):
        if not isinstance(option, dict):
            fail(errors, where, f"option {index} is not an object")
            continue
        label = str(option.get("label") or option.get("id") or "").strip().upper()
        text = " ".join(str(option.get("text") or "").split())
        if not re.fullmatch(r"[A-J]", label):
            fail(errors, where, f"option {index} has label {label!r}; expected a single letter A-J")
            continue
        if not text:
            fail(errors, where, f"option {label} has no text — that is the defect being repaired")
        if len(text) > MAX_OPTION_TEXT:
            fail(errors, where, f"option {label} is {len(text)} characters; that is body text, "
                                f"not an option")
        if BAD_CHARS_RE.search(text):
            fail(errors, where, f"option {label} contains OCR junk")
        if label in seen_labels:
            fail(errors, where, f"duplicate option label {label!r}")
        if text and text.lower() in seen_text:
            fail(errors, where, f"option {label} repeats the text of an earlier option — "
                                f"the list was mis-read")
        seen_labels.add(label)
        seen_text.add(text.lower())
        out.append({"id": label, "label": label, "text": text})

    if labels_expected:
        missing = sorted(set(labels_expected) - seen_labels)
        if missing:
            fail(errors, where, f"the fixture declares options {labels_expected} but the "
                                f"submission omits {missing}")
    missing_answers = sorted(answers_used - seen_labels)
    if missing_answers:
        fail(errors, where, f"the answer key uses {missing_answers}, which the submitted option "
                            f"list does not contain — the wrong list was read")
    return out


def validate(task: dict[str, Any], answer: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    errors: list[str] = []
    if str(answer.get("taskId")) != str(task.get("taskId")):
        fail(errors, "submission", f"taskId {answer.get('taskId')!r} does not match the task "
                                   f"{task.get('taskId')!r}")
        return {}, errors

    book = str(task["book"])
    module = str(task.get("module") or "")
    pdf_pages = list(task.get("pdfPageNumbers") or [])

    # -- the reader really looked at the page -------------------------------
    printed = answer.get("printedPageNumber")
    if not isinstance(printed, int):
        fail(errors, "submission", "printedPageNumber is missing; give the page number printed "
                                   "at the foot of the page you read")
    else:
        offsets = stage70.load_offsets()
        offset = printed - pdf_pages[0] if pdf_pages else 0
        known = offsets.get(book)
        if known is None:
            stage70.record_offset(book, offset)
        elif abs(offset - known) > 2:
            fail(errors, "submission",
                 f"printedPageNumber {printed} implies a front-matter offset of {offset} for "
                 f"C{book}, but this book has already been calibrated at {known}. Either the "
                 f"page number was invented or a different page was read.")

    headings = answer.get("questionsHeadingSeen")
    if not isinstance(headings, list) or not headings:
        fail(errors, "submission", "questionsHeadingSeen is missing; copy the 'Questions a-b' "
                                   "headings printed on the page")
        covered: set[int] = set()
    else:
        covered = heading_numbers([str(h) for h in headings])

    # -- every group in the task, none skipped ------------------------------
    task_groups = {str(g["groupId"]): g for g in task.get("groups") or []}
    pending = {gid for gid, g in task_groups.items() if not g.get("alreadyReviewed")}
    submitted = answer.get("groups")
    if not isinstance(submitted, list) or not submitted:
        fail(errors, "submission", "groups is empty")
        return {}, errors
    submitted_ids = [str(g.get("groupId")) for g in submitted if isinstance(g, dict)]
    unknown = sorted(set(submitted_ids) - set(task_groups))
    if unknown:
        fail(errors, "submission", f"groups {unknown} are not part of this task")
    skipped = sorted(pending - set(submitted_ids))
    if skipped:
        fail(errors, "submission", f"groups {skipped} are in the task but missing from the "
                                   f"submission; a task is answered whole or not at all")

    needed = {n for gid in submitted_ids if gid in task_groups
              for n in task_groups[gid].get("numbers") or []}
    uncovered = sorted(needed - covered)
    if uncovered and covered is not None:
        fail(errors, "submission",
             f"questionsHeadingSeen covers {sorted(covered) or 'nothing'} but this task also "
             f"needs {uncovered}. Either the heading was not copied accurately, or these "
             f"questions are printed on a page outside the task — widen it with "
             f"`50_worklist.py --expand {task['taskId']}`.")

    additions: dict[str, Any] = {}
    for entry in submitted:
        if not isinstance(entry, dict):
            fail(errors, "submission", "a group entry is not an object")
            continue
        gid = str(entry.get("groupId"))
        source = task_groups.get(gid) or {}
        where = f"group {gid}"
        status = entry.get("status")
        if status not in VALID_STATUS:
            fail(errors, where, f"status must be one of {sorted(VALID_STATUS)}, got {status!r}")
            continue
        if status == "flagged":
            note = str(entry.get("note") or "")
            if len(note) < 10:
                fail(errors, where, "flagged needs a note saying what is wrong with the page")
                continue
            additions[gid] = {"status": "flagged", "note": note,
                              "reviewedAt": datetime.now(timezone.utc).isoformat()}
            continue

        record: dict[str, Any] = {"status": status,
                                  "reviewedAt": datetime.now(timezone.utc).isoformat()}
        if entry.get("note"):
            record["note"] = str(entry["note"])

        wants_instruction = any("instruction" in r for r in source.get("gapReasons") or [])
        if "instruction" in entry or wants_instruction:
            value = check_instruction(entry.get("instruction"),
                                      str(source.get("currentInstruction") or ""),
                                      module, where, errors,
                                      allow_unchanged=(status == "approved"))
            if value:
                record["instruction"] = value

        wants_options = any("option" in r or "blank" in r for r in source.get("gapReasons") or [])
        if "options" in entry or wants_options:
            answers_used = {str(a).strip().upper()
                            for stem in source.get("stems") or []
                            for a in stem.get("acceptedAnswers") or []
                            if re.fullmatch(r"[A-J]", str(a).strip().upper())}
            options = check_option_list(entry.get("options"),
                                        [str(x).upper() for x in source.get("optionLabels") or []],
                                        answers_used, where, errors)
            if options:
                record["options"] = options
        if "instruction" not in record and "options" not in record:
            fail(errors, where, "nothing was submitted for this group")
        additions[gid] = record

    return additions, errors


def merge_overlay(exam_id: str, additions: dict[str, Any]) -> Path:
    path = OVERLAYS / f"{exam_id}.json"
    data = read_json(path) if path.exists() else {"schemaVersion": 1, "examId": exam_id}
    data.setdefault("questions", {})
    data.setdefault("groups", {}).update(additions)
    return write_json(path, data)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task", required=True)
    parser.add_argument("--answer", type=Path)
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args()

    hits = list(TASKS.glob(f"*/{args.task}.task.json"))
    if not hits:
        print(json.dumps({"ok": False, "errors": [f"no group task named {args.task!r}"]},
                         ensure_ascii=False, indent=2))
        return 2
    task_path = hits[0]
    task = read_json(task_path)
    answer_path = args.answer or task_path.with_name(f"{args.task}.answer.json")
    if not answer_path.exists():
        print(json.dumps({"ok": False, "errors": [f"no submission at {answer_path}"]},
                         ensure_ascii=False, indent=2))
        return 2
    try:
        answer = read_json(answer_path)
    except Exception as exc:
        print(json.dumps({"ok": False, "errors": [f"submission is not valid JSON: {exc}"]},
                         ensure_ascii=False, indent=2))
        return 2

    additions, errors = validate(task, answer)
    if errors:
        print(json.dumps({"ok": False, "taskId": args.task, "written": 0, "errors": errors},
                         ensure_ascii=False, indent=2))
        return 1
    if args.check_only:
        print(json.dumps({"ok": True, "taskId": args.task, "wouldWrite": len(additions),
                          "checkOnly": True}, ensure_ascii=False, indent=2))
        return 0
    path = merge_overlay(str(task["examId"]), additions)
    print(json.dumps({"ok": True, "taskId": args.task, "written": len(additions),
                      "overlay": str(path.relative_to(ROOT)).replace("\\", "/")},
                     ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
