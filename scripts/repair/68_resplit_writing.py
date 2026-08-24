# -*- coding: utf-8 -*-
"""Stage 13 — rebuild the writing task prompts the importer lost.

Six writing papers carry the literal string "Task prompt was not recoverable
from the MinerU page; review the source PDF." in place of the task, and one
has Task 2's text sitting inside Task 1. As with the reading passages, the
text is in the markdown; only the segmentation failed.

Writing has the cleanest anchors in the whole book:

    WRITING TASK 1
    You should spend about 20 minutes on this task.
    ...
    Write at least 150 words.

so Task 1 runs from its heading to Task 2's, and Task 2 from its heading to
the next test's Task 1. Where OCR lost a "WRITING TASK 2" heading the
40-minute line stands in for it -- Task 1 always says 20 minutes and Task 2
always says 40, in every book.

    python scripts/repair/68_resplit_writing.py           # report only
    python scripts/repair/68_resplit_writing.py --apply
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import BOOKS, FIXTURES, REPAIR, load_markdown, write_json  # noqa: E402

TASK_HEAD_RE = re.compile(r"^#{0,4}\s*\**\s*WRITING\s+TASK\s*([12])\b[^\n]*", re.I | re.M)
# Task 1 is always 20 minutes and Task 2 always 40; the minute count is a
# reliable stand-in when the heading itself did not survive OCR.
MINUTES_RE = re.compile(r"You\s+sh\w*\s+sp\w*\s+ab\w*\s+(20|40)\s*m\w*\s+on\s+th\w*\s+task", re.I)
WORDS_RE = re.compile(r"Write\s+at\s+least\s+(\d{3})\s+words", re.I)
PLACEHOLDER = "not recoverable"
LISTENING_MARKER_RE = re.compile(r"^\s*SECTION\s*[1-4]\b", re.M | re.I)
IMAGE_LINE_RE = re.compile(r"^\s*!\[\]\([^)]*\)\s*$")

MIN_PROMPT = 120
# A writing task is one short brief. Much past this and the slice has taken
# the next task, or the sample answers printed at the back of the book.
MAX_PROMPT = 2600


def clean(text: str) -> str:
    lines = [line for line in text.split("\n") if not IMAGE_LINE_RE.match(line)]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def anchors(markdown: str) -> list[tuple[int, int, int]]:
    """(position, task number, end) for every Task 1 / Task 2 opening."""
    found: dict[int, tuple[int, int, int]] = {}
    for match in TASK_HEAD_RE.finditer(markdown):
        found[match.start()] = (match.start(), int(match.group(1)), match.end())
    for match in MINUTES_RE.finditer(markdown):
        task = 1 if match.group(1) == "20" else 2
        # Keep the heading when both are present: it starts a little earlier
        # and carries the "WRITING TASK n" line the reader expects to see.
        if any(abs(match.start() - pos) < 200 for pos in found):
            continue
        found[match.start()] = (match.start(), task, match.start())
    return sorted(found.values())


def cut_at_word_count(text: str) -> str:
    """End the task at its own "Write at least N words." line.

    Without this a Task 2 slice runs to the next test's Task 1 -- a whole
    listening and reading paper away -- because nothing else separates them.
    """
    match = WORDS_RE.search(text)
    if match:
        return text[:match.end()].rstrip().rstrip(".") + "."
    # OCR sometimes loses the word-count line. Falling back to the next task's
    # opening keeps the slice from running through a whole listening and
    # reading paper to reach the next test.
    following = MINUTES_RE.search(text, 60)
    return text[:following.start()].strip() if following else text[:MAX_PROMPT].strip()


def assess(text: str, task: int | None = None) -> str | None:
    if len(text) < MIN_PROMPT:
        return f"only {len(text)} characters"
    if len(text) > MAX_PROMPT:
        return f"{len(text)} characters — the slice ran past the task"
    if PLACEHOLDER in text:
        return "still the importer's placeholder"
    if LISTENING_MARKER_RE.search(text):
        return "contains a listening SECTION heading"
    minutes = MINUTES_RE.findall(text)
    if len(minutes) > 1:
        return "holds both tasks — the split put Task 2 inside Task 1"
    # Task 1 is 20 minutes / 150 words, Task 2 is 40 minutes / 250 words. A
    # mismatch means this slot holds the other task's brief.
    if task and minutes and minutes[0] != ("20" if task == 1 else "40"):
        return f"says {minutes[0]} minutes, so this is not Task {task}"
    words = WORDS_RE.search(text)
    if task and words and words.group(1) != ("150" if task == 1 else "250"):
        return f"asks for {words.group(1)} words, so this is not Task {task}"
    return None


def needs_repair(exam: dict[str, Any]) -> bool:
    for section in exam.get("sections") or []:
        task = (exam.get("sections") or []).index(section) + 1
        text = str((section.get("content") or {}).get("text") or "")
        if assess(text.strip(), task) is not None:
            return True
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--books", type=str, default="")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--out", type=Path, default=REPAIR / "writing-resplit.json")
    args = parser.parse_args()

    books = [int(b) for b in args.books.split(",") if b.strip()] or list(BOOKS)
    results: list[dict[str, Any]] = []
    counts = {"exams": 0, "filled": 0, "left": 0, "skipped": 0, "examsTouched": 0}

    for book in books:
        paths = sorted(FIXTURES.glob(f"cambridge-{book}-test-*-writing.json"))
        if not paths:
            continue
        broken = [p for p in paths if needs_repair(json.loads(p.read_text(encoding="utf-8")))]
        if not broken:
            counts["skipped"] += len(paths)
            continue
        markdown = load_markdown(book)
        found = anchors(markdown)
        # Group into tests: every Task 1 opens a new test.
        tests: list[dict[int, tuple[int, int]]] = []
        for index, (start, task, end) in enumerate(found):
            stop = found[index + 1][0] if index + 1 < len(found) else len(markdown)
            if task == 1 or not tests:
                tests.append({})
            tests[-1][task] = (end, stop)

        for path in paths:
            exam = json.loads(path.read_text(encoding="utf-8"))
            if not needs_repair(exam):
                counts["skipped"] += 1
                continue
            counts["exams"] += 1
            match = re.search(r"-test-(\d)-writing$", exam["id"])
            slot = int(match.group(1)) - 1 if match else -1
            spans = tests[slot] if 0 <= slot < len(tests) else {}
            record: dict[str, Any] = {"exam": exam["id"], "tasks": []}
            changed = False
            for index, section in enumerate(exam.get("sections") or []):
                task = index + 1
                current = str((section.get("content") or {}).get("text") or "").strip()
                span = spans.get(task)
                text = cut_at_word_count(clean(markdown[span[0]:span[1]])) if span else ""
                reason = assess(text, task) if text else "no WRITING TASK anchor found"
                healthy = assess(current, task) is None
                write = reason is None and not healthy
                if write:
                    counts["filled"] += 1
                    if args.apply:
                        section.setdefault("content", {})["format"] = "plain"
                        section["content"]["text"] = text
                        changed = True
                elif not healthy:
                    counts["left"] += 1
                record["tasks"].append({
                    "section": section.get("id"),
                    "chars": len(text),
                    "action": "fill" if write else ("keep" if healthy else "leave"),
                    "reason": reason,
                    "head": text[:80],
                })
            if args.apply and changed:
                backup = path.with_suffix(".json.bak")
                if not backup.exists():
                    backup.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
                exam["contentRevision"] = f"wsplit-{exam['id'][-18:]}"
                path.write_text(json.dumps(exam, ensure_ascii=False, indent=2) + "\n",
                                encoding="utf-8")
                counts["examsTouched"] += 1
            results.append(record)

    write_json(args.out, {"schemaVersion": 1, "counts": counts, "exams": results})
    print(json.dumps(counts, ensure_ascii=False))
    for record in results:
        print(f"  {record['exam']}")
        for entry in record["tasks"]:
            tail = "" if entry["action"] in ("fill", "keep") else f"  ← {entry['reason']}"
            print(f"     {entry['action']:<5} {entry['section']:<6} {entry['chars']:>5} chars"
                  f"{tail}  {entry['head'][:52]!r}")
    print(f"\nreport → {args.out}")
    if not args.apply:
        print("(report only; rerun with --apply to write)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
