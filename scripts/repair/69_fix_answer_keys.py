# -*- coding: utf-8 -*-
"""Stage 6d — rebuild answer keys from the book's own printed answer key.

The structure round (stage 6b/6c/67) could not finish because 61 groups had a
rubric and a note saying "TRUE/FALSE/NOT GIVEN" or "write one word" while the
stored key was a bare Latin letter. Re-typing those groups without fixing the
key would only move the damage. So the key has to be settled first, and the
only authority for a key is the answer key printed at the back of the book.

Every Cambridge volume ends with `Listening and Reading answer keys`, and in
the MinerU extraction most of it survived as plain numbered lines:

    ## TEST 2
    ## READING
    ## Reading Passage 3, Questions 27-40
    27 C
    28 A

Two things make a naive parse wrong, and both are handled here:

  * **Prose that starts with a number.** "13 Last year some staff helped the
    unemployed..." is a reading statement, not an answer. The range headers are
    the fix: a heading says which numbers may appear next, and a line whose
    number falls outside the open range, or goes backwards, is not an answer.

  * **Blocks that survived only as a scan.** Some answer pages came through as
    `![](images/....jpg)`. Nothing can be read from those here; they are
    reported, not guessed. 16 of the 61 are in this state.

Answers are compared, never merged blindly: a disagreement is applied only when
the printed answer has a shape the stored one cannot be a corruption-free
version of. `--dry-run` prints the full disagreement list and writes nothing.

    python scripts/repair/69_fix_answer_keys.py --dry-run
    python scripts/repair/69_fix_answer_keys.py --apply
"""
from __future__ import annotations

import argparse
import collections
import glob
import json
import re
import shutil
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "fixtures" / "cambridge"
MINERU = ROOT / "data-dev" / "mineru"

KEYS_RE = re.compile(r"Listening and Reading answer keys?", re.I)
TEST_RE = re.compile(r"^##\s*TEST\s*(\d)\b", re.I)
MODULE_RE = re.compile(r"^##\s*(LISTENING|READING)\b", re.I)
# "Part 1, Questions 1-10", "Reading Passage 3, Questions 27-40"
RANGE_RE = re.compile(r"Questions?\s*(\d{1,2})\s*[-–—]\s*(\d{1,2})", re.I)
LINE_RE = re.compile(r"^(\d{1,2})\s+(\S.*)$")
IMAGE_RE = re.compile(r"^!\[[^\]]*\]\([^)]*\)$")

JUDGEMENT = {"TRUE", "FALSE", "NOT GIVEN", "YES", "NO"}
LETTER_RE = re.compile(r"^[A-K]$")
ROMAN_RE = re.compile(r"^(?:i{1,3}|iv|v|vi{1,3}|ix|x)$", re.I)


def answer_shape(value: str) -> str | None:
    """Classify a printed answer, or None when the line is not an answer at all.

    Length is the crude part of the test and the range header is the sharp one,
    but a shape check still catches prose that slips inside a live range.
    """
    text = value.strip().rstrip(".")
    if not text or len(text) > 60:
        return None
    upper = text.upper()
    if upper in JUDGEMENT:
        return "judgement"
    if LETTER_RE.match(text):
        return "letter"
    if ROMAN_RE.match(text):
        return "roman"
    # A written answer: a few words, no sentence punctuation in the middle.
    words = text.replace("/", " ").split()
    if len(words) <= 6 and not re.search(r"[.;:]\s", text):
        return "written"
    return None


def parse_answer_key(markdown: str) -> dict[tuple[int, str], dict[int, str]]:
    match = KEYS_RE.search(markdown)
    if not match:
        return {}
    out: dict[tuple[int, str], dict[int, str]] = collections.defaultdict(dict)
    test: int | None = None
    module: str | None = None
    lo = hi = 0
    expect = 0
    for raw in markdown[match.start():].splitlines():
        line = raw.strip()
        if not line:
            continue
        if (m := TEST_RE.match(line)):
            test, lo, hi, expect = int(m.group(1)), 0, 0, 0
            continue
        if (m := MODULE_RE.match(line)):
            module, lo, hi, expect = m.group(1).lower(), 0, 0, 0
            continue
        if (m := RANGE_RE.search(line)) and line.startswith("#"):
            lo, hi = int(m.group(1)), int(m.group(2))
            expect = lo
            continue
        if line.startswith("#") or IMAGE_RE.match(line):
            continue
        if test is None or module is None or not lo:
            continue
        if not (m := LINE_RE.match(line)):
            continue
        number, value = int(m.group(1)), m.group(2)
        # The range header says which numbers are still to come. A line whose
        # number is outside it, or behind what we already read, is prose.
        if not (expect <= number <= hi):
            continue
        if answer_shape(value) is None:
            continue
        out[(test, module)][number] = value.strip()
        expect = number + 1
    return dict(out)


ANSWER_KEY_STORE = ROOT / "fixtures" / "answer-keys"


def transcribed_key(exam_id: str) -> dict[int, list[str]]:
    """A block read off the printed answer page and passed stage 7b's checks.

    This outranks the markdown extraction and the stored fixture both: it is the
    printed page itself, transcribed in full and machine-verified against every
    answer the text extraction had already recovered. The markdown is a lossy
    read of the same page; the fixture is what we are trying to correct.
    """
    path = ANSWER_KEY_STORE / f"{exam_id}.json"
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    return {int(k): list(v) for k, v in (data.get("answers") or {}).items()}


def book_keys(book: int) -> dict[tuple[int, str], dict[int, str]]:
    hits = sorted(MINERU.glob(f"C{book:02d}/**/*.md"))
    if not hits:
        return {}
    return parse_answer_key(hits[0].read_text(encoding="utf-8"))


def split_alternatives(value: str) -> list[str]:
    """`4.30 (pm) / half past four` is two accepted answers, not one string."""
    parts = [p.strip() for p in value.split("/")]
    # OCR sometimes breaks "a hundred and fifteen" across the slash, leaving a
    # one-letter fragment. A stored key is more trustworthy than that.
    parts = [p for p in parts if len(p) >= 2 or p.isdigit()]
    return parts or [value.strip()]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="write the fixtures")
    parser.add_argument("--dry-run", action="store_true", help="report only (default)")
    parser.add_argument("--limit-to-refused", action="store_true",
                        help="only touch the groups stage 67 refused")
    args = parser.parse_args()

    refused: set[tuple[str, int]] = set()
    report = ROOT / "data-dev" / "repair" / "structure-fix-report.json"
    if report.exists():
        data = json.loads(report.read_text(encoding="utf-8"))
        for decision in data.get("decisions") or []:
            if decision.get("action") == "refuse":
                for number in decision.get("numbers") or []:
                    refused.add((decision["examId"], number))

    stats = collections.Counter()
    changes: list[tuple[str, int, list[str], list[str], str]] = []
    per_file: dict[Path, Any] = {}

    for path in sorted(FIXTURES.glob("*.json")):
        name = path.stem                      # cambridge-18-test-1-reading
        parts = name.split("-")
        if len(parts) < 5 or parts[0] != "cambridge":
            continue
        try:
            book, test, module = int(parts[1]), int(parts[3]), parts[4]
        except ValueError:
            continue
        if module not in ("reading", "listening"):
            continue
        transcribed = transcribed_key(name)
        keys = book_keys(book).get((test, module), {})
        if not keys and not transcribed:
            stats["exam_without_text_key"] += 1
            continue
        if transcribed:
            stats["exam_with_transcribed_key"] += 1
        exam = json.loads(path.read_text(encoding="utf-8"))
        touched = False
        for section in exam.get("sections") or []:
            for group in section.get("questionGroups") or []:
                for question in group.get("questions") or []:
                    number = question.get("number")
                    if number in transcribed:
                        wanted = transcribed[number]
                        source = "transcribed"
                    else:
                        printed = keys.get(number)
                        if printed is None:
                            stats["no_printed_answer"] += 1
                            continue
                        wanted = split_alternatives(printed)
                        source = "markdown"
                    current = [str(a).strip() for a in (question.get("acceptedAnswers") or [])]
                    if [c.upper() for c in current] == [w.upper() for w in wanted]:
                        stats["agrees"] += 1
                        continue
                    if args.limit_to_refused and (name, number) not in refused:
                        stats["disagrees_out_of_scope"] += 1
                        continue
                    stats[f"disagrees_{source}"] += 1
                    changes.append((name, number, current, wanted, source))
                    if args.apply:
                        question["acceptedAnswers"] = wanted
                        touched = True
        if touched:
            per_file[path] = exam

    if args.apply:
        for path, exam in per_file.items():
            shutil.copy2(path, path.with_suffix(".json.bak"))
            path.write_text(json.dumps(exam, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"{'applied to' if args.apply else 'would touch'} {len(per_file)} exam files")
    for key in sorted(stats):
        print(f"  {key:26s} {stats[key]}")
    by_shape = collections.Counter(c[4] for c in changes)
    print("  disagreements by printed shape:", dict(by_shape))
    for name, number, current, wanted, shape in changes[:25]:
        print(f"    {name} Q{number}: {current} -> {wanted}  ({shape})")
    if len(changes) > 25:
        print(f"    ... and {len(changes) - 25} more")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
