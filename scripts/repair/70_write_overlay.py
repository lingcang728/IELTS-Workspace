# -*- coding: utf-8 -*-
"""Stage 7 — validate a proofreading submission and write it to the overlay.

This is the gate between the reading model and the corpus. It assumes the
submitter is careless, so a submission is accepted **only as a whole**: if any
single question fails a check, nothing is written and the whole task must be
redone. Partial credit is what produces half-repaired papers.

The checks are not stylistic. Each one exists because the corpus already
contains the failure it prevents:

* prompts that are really the group instruction ("Complete the notes below.")
* prompts duplicated across questions in one paper
* prompts that are transcript fragments starting mid-sentence
* answers that are OCR junk (CJK watermark, tick marks, table rules)
* option-lettered answers on questions carrying no options
* placeholder text left in place

Two checks exist purely to prove the page was actually looked at, because a
model that guesses from `currentPrompt` alone would otherwise pass everything:

* ``questionsHeadingSeen`` must cover every question number in the task
* ``pageAsPrinted`` must be one of the pages the task rendered

    python scripts/repair/70_write_overlay.py --task <taskId>
    python scripts/repair/70_write_overlay.py --task <taskId> --check-only
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import OVERLAYS, REPAIR, ROOT, read_json, write_json  # noqa: E402

TASKS = REPAIR / "tasks"
VALID_STATUS = {"corrected", "approved", "flagged"}
VALID_TYPES = {
    "completion", "short_answer", "single_choice", "multi_choice",
    "matching", "labelling", "true_false_ng", "yes_no_ng",
}
OPTIONED_TYPES = {"single_choice", "multi_choice", "matching", "labelling"}
TFNG_ANSWERS = {"true", "false", "not given", "yes", "no"}

BAD_CHARS_RE = re.compile(r"[　-〿一-鿿＀-￯✓✗√□☐\x00-\x08]")
ANSWER_MARKER_RE = re.compile(r"\bQ\s?\d{1,2}\b")
PLACEHOLDER_RE = re.compile(r"write the answer from the source|^\s*question\s*\d+\s*$", re.I)
INSTRUCTION_ONLY_RE = re.compile(
    r"^(?:Complete|Choose|Write|Answer|Label|Match|Classify|Do the following)\b[^?]*\.$", re.I)
LOWER_OPENERS = {
    "a", "an", "the", "to", "how", "why", "what", "when", "where", "which", "who",
    "details", "description", "reference", "mention", "examples", "example", "in",
    "of", "for", "and", "or", "not", "no", "one", "two", "some", "many", "most",
}
RANGE_RE = re.compile(r"(\d{1,2})\s*(?:[-–—]|and|to|&)\s*(\d{1,2})")
SINGLE_RE = re.compile(r"\b(\d{1,2})\b")
MIN_PROMPT = 12
MIN_PROMPT_MATCHING = 5


OFFSETS_PATH = REPAIR / "printed-page-offsets.json"


class Rejected(Exception):
    pass


def load_offsets() -> dict[str, int]:
    if not OFFSETS_PATH.exists():
        return {}
    try:
        return {str(k): int(v) for k, v in read_json(OFFSETS_PATH).items()}
    except (ValueError, TypeError, AttributeError):
        return {}


def record_offset(book: str, offset: int) -> None:
    offsets = load_offsets()
    offsets.setdefault(book, offset)
    write_json(OFFSETS_PATH, offsets)


def fail(errors: list[str], where: str, message: str) -> None:
    errors.append(f"{where}: {message}")


def heading_numbers(headings: list[str]) -> set[int]:
    """Question numbers covered by the 'Questions a-b' headings the reader saw."""
    covered: set[int] = set()
    for heading in headings:
        text = str(heading)
        matched = False
        for match in RANGE_RE.finditer(text):
            low, high = int(match.group(1)), int(match.group(2))
            if 1 <= low <= high <= 40:
                covered |= set(range(low, high + 1))
                matched = True
        if not matched:
            for match in SINGLE_RE.finditer(text):
                value = int(match.group(1))
                if 1 <= value <= 40:
                    covered.add(value)
    return covered


def check_prompt(prompt: str, current: str, qtype: str, where: str, errors: list[str],
                 allow_unchanged: bool = False) -> None:
    if not isinstance(prompt, str) or not prompt.strip():
        fail(errors, where, "prompt is empty")
        return
    text = prompt.strip()
    floor = MIN_PROMPT_MATCHING if qtype in {"matching", "labelling"} else MIN_PROMPT
    if len(text) < floor:
        fail(errors, where, f"prompt is {len(text)} chars, minimum {floor} for type {qtype!r}")
    if BAD_CHARS_RE.search(text):
        fail(errors, where, "prompt contains CJK or OCR junk characters")
    if ANSWER_MARKER_RE.search(text):
        fail(errors, where, "prompt still contains a Q-marker from the audioscript")
    if PLACEHOLDER_RE.search(text):
        fail(errors, where, "prompt is still placeholder text")
    if INSTRUCTION_ONLY_RE.match(text):
        fail(errors, where, f"prompt is the group instruction, not a question: {text[:50]!r}")
    # A question flagged only for a broken answer key keeps its correct prompt.
    # That is exactly what  means, so the unchanged check is skipped
    # for it -- but it still has to pass every other rule.
    if current and text == current.strip() and not allow_unchanged:
        fail(errors, where, "prompt is unchanged from the broken original; if the prompt on "
                           "the page really is this text, use status 'approved' instead")
    if text[0] in ",.;:!?)]}":
        fail(errors, where, "prompt starts on punctuation (transcript fragment)")
    if text[0].islower():
        first = re.match(r"[a-z']+", text)
        if first and first.group(0) not in LOWER_OPENERS:
            fail(errors, where, f"prompt starts mid-word: {text[:40]!r}")
    if "\\_" in text or "\\*" in text:
        fail(errors, where, "prompt contains raw markdown escapes")


def check_answers(answers: list[Any], qtype: str, options: list[dict[str, Any]],
                  where: str, errors: list[str]) -> None:
    if not isinstance(answers, list) or not answers:
        fail(errors, where, "acceptedAnswers is empty")
        return
    cleaned = [str(a).strip() for a in answers]
    if not all(cleaned):
        fail(errors, where, "acceptedAnswers contains a blank entry")
    for value in cleaned:
        if BAD_CHARS_RE.search(value):
            fail(errors, where, f"acceptedAnswers contains OCR junk: {value[:24]!r}")
    if qtype in {"true_false_ng", "yes_no_ng"}:
        if any(v.lower() not in TFNG_ANSWERS for v in cleaned):
            fail(errors, where, f"{qtype} answer must be TRUE/FALSE/NOT GIVEN or YES/NO/NOT GIVEN, got {cleaned}")
    if qtype in OPTIONED_TYPES:
        labels = {str(o.get("id", "")).strip().lower() for o in options}
        labels |= {str(o.get("label", "")).strip().lower() for o in options}
        missing = [v for v in cleaned if v.lower() not in labels]
        if missing:
            fail(errors, where, f"answers {missing} are not among the option labels {sorted(labels)}")


def check_options(options: Any, qtype: str, where: str, errors: list[str]) -> list[dict[str, Any]]:
    if qtype not in OPTIONED_TYPES:
        return []
    if not isinstance(options, list) or len(options) < 2:
        fail(errors, where, f"type {qtype!r} needs at least two options, got {options!r}")
        return []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, option in enumerate(options):
        if not isinstance(option, dict):
            fail(errors, where, f"option {index} is not an object")
            continue
        label = str(option.get("label") or option.get("id") or "").strip()
        text = str(option.get("text") or "").strip()
        if not label:
            fail(errors, where, f"option {index} has no label")
        if not text:
            fail(errors, where, f"option {label or index} has no text")
        if BAD_CHARS_RE.search(text):
            fail(errors, where, f"option {label} contains OCR junk")
        key = label.lower()
        if key in seen:
            fail(errors, where, f"duplicate option label {label!r}")
        seen.add(key)
        out.append({"id": label.lower() if not label.isupper() else label, "label": label, "text": text})
    return out


def existing_prompts(exam_id: str, exclude: set[str]) -> dict[str, str]:
    path = ROOT / "fixtures" / "cambridge" / f"{exam_id}.json"
    if not path.exists():
        return {}
    exam = read_json(path)
    out: dict[str, str] = {}
    for section in exam.get("sections") or []:
        for group in section.get("questionGroups") or []:
            for question in group.get("questions") or []:
                qid = question.get("id")
                if qid in exclude:
                    continue
                prompt = str(question.get("prompt") or "").strip()
                if prompt:
                    out[prompt] = qid
    return out


def validate(task: dict[str, Any], answer: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    errors: list[str] = []

    if answer.get("taskId") != task["taskId"]:
        fail(errors, "submission", f"taskId {answer.get('taskId')!r} does not match {task['taskId']!r}")

    # --- proof that the page was actually read -----------------------------
    # `printedPageNumber` is the number printed at the foot of the rendered
    # page, which is NOT the PDF page number (Cambridge front matter offsets
    # them). The offset is learned from the first accepted task of each book and
    # enforced afterwards, so a model that invents the number is caught from the
    # second task on without anyone having to look the offset up.
    page_seen = answer.get("printedPageNumber")
    if not isinstance(page_seen, int) or not 1 <= page_seen <= 500:
        fail(errors, "submission",
             "printedPageNumber must be the integer printed at the foot of the page image")
    else:
        offsets = load_offsets()
        key = str(task["book"])
        expected = offsets.get(key)
        candidates = [page_seen - (p + 1) for p in task["pdfPagesZeroBased"]]
        if expected is None:
            record_offset(key, candidates[0])
        elif not any(abs(c - expected) <= 1 for c in candidates):
            fail(errors, "submission",
                 f"printedPageNumber {page_seen} is inconsistent with book {key}: earlier tasks put the "
                 f"printed number {expected:+d} from the PDF page, which would make this page "
                 f"{task['pdfPagesZeroBased'][0] + 1 + expected}. Read the number off the image.")
    headings = answer.get("questionsHeadingSeen")
    if not isinstance(headings, list) or not headings:
        fail(errors, "submission", "questionsHeadingSeen is required: transcribe every "
                                   "'Questions a-b' heading visible on the page")
    else:
        covered = heading_numbers(headings)
        wanted = {q["number"] for q in task["questions"] if not q["alreadyReviewed"]}
        uncovered = sorted(wanted - covered)
        if uncovered:
            fail(errors, "submission",
                 f"questionsHeadingSeen {headings} does not cover question(s) {uncovered}; "
                 f"either you are on the wrong page or you did not transcribe the heading")

    # --- coverage: no partial submissions ----------------------------------
    submitted = answer.get("questions")
    if not isinstance(submitted, list):
        raise Rejected("submission has no 'questions' array")
    by_number: dict[int, dict[str, Any]] = {}
    for entry in submitted:
        number = entry.get("number")
        if not isinstance(number, int):
            fail(errors, "submission", f"entry without an integer 'number': {str(entry)[:60]}")
            continue
        if number in by_number:
            fail(errors, f"q{number}", "submitted twice")
        by_number[number] = entry
    required = {q["number"] for q in task["questions"] if not q["alreadyReviewed"]}
    missing = sorted(required - set(by_number))
    if missing:
        fail(errors, "submission", f"question(s) {missing} not submitted — every question in the "
                                   f"task must be answered in the same submission")
    extra = sorted(set(by_number) - {q["number"] for q in task["questions"]})
    if extra:
        fail(errors, "submission", f"question(s) {extra} are not part of this task")

    # --- per-question checks -----------------------------------------------
    task_by_number = {q["number"]: q for q in task["questions"]}
    prompts_here: dict[str, int] = {}
    output: dict[str, Any] = {}
    for number in sorted(required):
        entry = by_number.get(number)
        if entry is None:
            continue
        where = f"q{number}"
        source = task_by_number[number]
        status = entry.get("status")
        if status not in VALID_STATUS:
            fail(errors, where, f"status must be one of {sorted(VALID_STATUS)}, got {status!r}")
            continue

        if status == "flagged":
            note = str(entry.get("note") or "").strip()
            if len(note) < 10:
                fail(errors, where, "flagged questions need a 'note' of at least 10 characters "
                                    "saying what is wrong and what you could not read")
            output[source["questionId"]] = {
                "status": "flagged",
                "note": note,
                "printedPageNumber": page_seen,
                "reviewedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }
            continue

        qtype = entry.get("type") or source.get("currentType")
        if qtype not in VALID_TYPES:
            fail(errors, where, f"type must be one of {sorted(VALID_TYPES)}, got {qtype!r}")
            qtype = source.get("currentType")

        options = check_options(entry.get("options"), qtype, where, errors)
        prompt = str(entry.get("prompt") or "").strip()
        check_prompt(prompt, str(source.get("currentPrompt") or ""), qtype, where, errors,
                     allow_unchanged=(status == "approved"))

        answers = entry.get("acceptedAnswers")
        if answers is None:
            answers = source.get("acceptedAnswers") or []
        check_answers(answers, qtype, options, where, errors)

        if prompt:
            if prompt in prompts_here:
                fail(errors, where, f"prompt is identical to q{prompts_here[prompt]} in this submission")
            prompts_here[prompt] = number

        record: dict[str, Any] = {
            "status": status,
            "prompt": prompt,
            "type": qtype,
            "acceptedAnswers": [str(a).strip() for a in answers],
            "printedPageNumber": page_seen,
            "reviewedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        if options:
            record["options"] = options
        if entry.get("gapText"):
            record["gapText"] = str(entry["gapText"])
        if entry.get("note"):
            record["note"] = str(entry["note"])
        output[source["questionId"]] = record

    # --- cross-check against the rest of the paper -------------------------
    others = existing_prompts(task["examId"], exclude=set(output))
    for qid, record in output.items():
        prompt = record.get("prompt")
        if prompt and prompt in others:
            fail(errors, qid, f"prompt duplicates question {others[prompt]} elsewhere in this paper")

    return output, errors


def merge_overlay(exam_id: str, additions: dict[str, Any]) -> Path:
    path = OVERLAYS / f"{exam_id}.json"
    if path.exists():
        data = read_json(path)
    else:
        data = {"schemaVersion": 1, "examId": exam_id, "questions": {}}
    data.setdefault("questions", {}).update(additions)
    return write_json(path, data)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task", required=True, help="task id, e.g. cambridge-8-test-1-reading-p0012")
    parser.add_argument("--answer", type=Path, help="submission JSON (default: <task>.answer.json)")
    parser.add_argument("--check-only", action="store_true", help="validate without writing")
    args = parser.parse_args()

    hits = list(TASKS.glob(f"*/{args.task}.task.json"))
    if not hits:
        print(f"REJECTED: no task file for {args.task!r} under {TASKS}", file=sys.stderr)
        return 2
    task = read_json(hits[0])
    answer_path = args.answer or hits[0].with_name(f"{args.task}.answer.json")
    if not answer_path.exists():
        print(f"REJECTED: no submission at {answer_path}", file=sys.stderr)
        return 2
    try:
        answer = json.loads(answer_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"REJECTED: submission is not valid JSON ({exc})", file=sys.stderr)
        return 2

    try:
        output, errors = validate(task, answer)
    except Rejected as exc:
        print(f"REJECTED: {exc}", file=sys.stderr)
        return 2

    if errors:
        print(f"REJECTED: {len(errors)} problem(s) in {args.task}. NOTHING was written; "
              f"fix the submission and rerun.", file=sys.stderr)
        for line in errors:
            print(f"  - {line}", file=sys.stderr)
        return 1

    if args.check_only:
        print(json.dumps({"ok": True, "taskId": args.task, "questions": len(output),
                          "wrote": False}, ensure_ascii=False))
        return 0

    path = merge_overlay(task["examId"], output)
    print(json.dumps({"ok": True, "taskId": args.task, "questions": len(output),
                      "overlay": str(path.relative_to(ROOT)).replace("\\", "/")}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
