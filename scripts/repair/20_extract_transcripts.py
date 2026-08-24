# -*- coding: utf-8 -*-
"""Stage 3 — pull the listening audioscripts out of the MinerU markdown.

Cambridge prints the full listening transcript as a book appendix, in
speaker-labelled dialogue form, with a ``Q1``..``Q40`` marker printed beside
the line that contains each answer. That marker is the valuable part: it lets
the review screen say *"the answer to this question is in this sentence"*
without any audio alignment, which the corpus has no timestamps for.

Output: ``fixtures/transcripts/{exam-id}.json``, one file per listening paper.

The appendix is laid out three different ways across the corpus -- plain
paragraphs, ``<table>`` blocks with a speaker column, and a single wide table
cell holding an entire page -- so the extractor normalises all of them into a
flat list of ``{speaker, text, answers}`` lines.
"""
from __future__ import annotations

import argparse
import html
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import (  # noqa: E402
    AUDIO_BOOKS,
    REPAIR,
    SECTION_RE,
    TRANSCRIPTS,
    exam_id,
    iter_questions,
    load_exam,
    load_markdown,
    read_json,
    squash,
    write_json,
)

TEST_HEADING_RE = re.compile(r"^#{0,3}\s*TEST\s*([1-4])\s*$", re.I | re.M)
# "Q1", "Q 1", "Q1/Q2" and the odd "QI" where OCR read the digit 1 as a letter.
ANSWER_MARKER_RE = re.compile(r"\bQ\s?(\d{1,2})\b")
SPEAKER_RE = re.compile(r"^([A-Z][A-Z .'\-]{1,28}):\s*")
TAG_RE = re.compile(r"<[^>]+>")


def cell_texts(block: str) -> list[str]:
    """Flatten one <table> into row strings, keeping the speaker/text split."""
    rows = re.findall(r"<tr>(.*?)</tr>", block, flags=re.S | re.I)
    out: list[str] = []
    for row in rows:
        cells = [html.unescape(TAG_RE.sub(" ", cell)).strip()
                 for cell in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, flags=re.S | re.I)]
        cells = [c for c in cells if c]
        if not cells:
            continue
        out.append("  ".join(cells))
    return out


def flatten(region: str) -> list[str]:
    """Markdown region -> ordered plain lines, tables expanded in place."""
    lines: list[str] = []
    position = 0
    for match in re.finditer(r"<table>.*?</table>", region, flags=re.S | re.I):
        for raw in region[position:match.start()].splitlines():
            if raw.strip():
                lines.append(raw.strip())
        lines.extend(cell_texts(match.group(0)))
        position = match.end()
    for raw in region[position:].splitlines():
        if raw.strip():
            lines.append(raw.strip())
    return lines


def split_line(line: str) -> tuple[str | None, str]:
    match = SPEAKER_RE.match(line)
    if not match:
        return None, line.strip()
    return match.group(1).strip().rstrip(":"), line[match.end():].strip()


def parse_section(region: str) -> list[dict[str, Any]]:
    """One listening section -> transcript lines with their answer markers."""
    out: list[dict[str, Any]] = []
    for raw in flatten(region):
        if re.fullmatch(r"[#\s\d]*", raw):
            continue
        if re.fullmatch(r"#{1,3}\s*(SECTION|PART|TEST)\s*\d\s*", raw, re.I):
            continue
        answers = sorted({int(m.group(1)) for m in ANSWER_MARKER_RE.finditer(raw)})
        text = squash(ANSWER_MARKER_RE.sub(" ", raw).lstrip("#").strip())
        if not text:
            continue
        speaker, body = split_line(text)
        if not body:
            continue
        out.append({"speaker": speaker, "text": body, "answers": [a for a in answers if 1 <= a <= 40]})
    return out


def slice_appendix(text: str, start: int) -> dict[int, dict[int, tuple[int, int]]]:
    """Split the appendix into (test, section) regions by SECTION-number cycles.

    ``TEST n`` headings cannot carry this: C12 has none at all, and C13/C16
    repeat them as running page headers so the first occurrence of "TEST 2"
    lands in the middle of Test 1. The section numbers do carry it -- the
    appendix is sixteen sections printed as four ascending 1,2,3,4 cycles -- and
    a cycle that restarts is an unambiguous test boundary. Everything after the
    fourth cycle is the answer key, which reuses the same words and must be cut
    off.
    """
    heads = [(int(m.group(1)), m.start()) for m in SECTION_RE.finditer(text, start)]
    slots: list[tuple[int, int, int]] = []
    test = 1
    previous = 0
    for value, position in heads:
        if not 1 <= value <= 4:
            continue
        if value <= previous:
            test += 1
            if test > 4:
                break
        slots.append((test, value, position))
        previous = value

    end_of_appendix = slots[-1][2] if slots else start
    # The final section runs to wherever the fifth cycle (the answer key) began.
    tail = next((position for value, position in heads if position > end_of_appendix), len(text))

    spans: dict[int, dict[int, tuple[int, int]]] = {}
    for index, (test_no, section_no, position) in enumerate(slots):
        stop = slots[index + 1][2] if index + 1 < len(slots) else tail
        spans.setdefault(test_no, {})[section_no] = (position, stop)
    return spans


def extract_book(book: int, index: dict[str, Any]) -> list[dict[str, Any]]:
    record = next((b for b in index["books"] if b["book"] == book), None)
    if record is None or record.get("transcriptStart") is None:
        return []
    text = load_markdown(book)
    spans = slice_appendix(text, record["transcriptStart"])
    results: list[dict[str, Any]] = []
    for test in (1, 2, 3, 4):
        exam = load_exam(book, test, "listening")
        if exam is None:
            continue
        found = spans.get(test)
        if not found:
            results.append({"book": book, "test": test, "ok": False, "reason": "no sections located in appendix"})
            continue
        payload_sections = []
        for position in range(4):
            bounds = found.get(position + 1)
            lines = parse_section(text[bounds[0]:bounds[1]]) if bounds else []
            payload_sections.append({
                "index": position,
                "sectionId": (exam["sections"][position]["id"] if position < len(exam["sections"]) else None),
                "lines": lines,
                # A real Cambridge section transcript runs 2000-5000 characters.
                # Anything far below that means the appendix headings for this
                # section were not found and its text landed in a sibling.
                "charCount": sum(len(line["text"]) for line in lines),
                "missing": bounds is None,
            })
        located = {a for s in payload_sections for line in s["lines"] for a in line["answers"]}
        expected = {q["number"] for _s, _g, q in iter_questions(exam) if isinstance(q.get("number"), int)}
        results.append({
            "book": book,
            "test": test,
            "ok": True,
            "examId": exam_id(book, test, "listening"),
            "sections": payload_sections,
            "answerMarkers": sorted(located),
            "missingMarkers": sorted(expected - located),
            "lineCount": sum(len(s["lines"]) for s in payload_sections),
            "charCount": sum(s["charCount"] for s in payload_sections),
            "thinSections": [s["index"] for s in payload_sections if s["charCount"] < 800],
        })
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--books", type=str, default="")
    parser.add_argument("--index", type=Path, default=REPAIR / "source-index.json")
    parser.add_argument("--out", type=Path, default=TRANSCRIPTS)
    args = parser.parse_args()
    index = read_json(args.index)
    books = [int(b) for b in args.books.split(",") if b.strip()] or list(AUDIO_BOOKS)

    written = 0
    print(f"{'Book':<6}{'test':>5}{'lines':>7}{'Q found':>9}  missing")
    summary: list[dict[str, Any]] = []
    for book in books:
        for result in extract_book(book, index):
            summary.append({k: v for k, v in result.items() if k != "sections"})
            if not result.get("ok"):
                print(f"C{book:02d}  {result['test']:>5}{'':>7}{'':>9}  SKIPPED: {result['reason']}")
                continue
            payload = {
                "schemaVersion": 1,
                "examId": result["examId"],
                "source": {"kind": "mineru", "book": book, "test": result["test"]},
                "note": "Cambridge audioscript appendix. Q-markers show which line carries each answer.",
                "answerMarkers": result["answerMarkers"],
                "missingMarkers": result["missingMarkers"],
                "sections": result["sections"],
            }
            write_json(args.out / f"{result['examId']}.json", payload)
            written += 1
            thin = result["thinSections"]
            print(f"C{book:02d}  {result['test']:>5}{result['charCount']:>8}"
                  f"{len(result['answerMarkers']):>6}/40  "
                  f"{'-' if not thin else 'thin sections ' + str(thin)}")
    write_json(REPAIR / "transcript-summary.json", {"schemaVersion": 1, "results": summary})
    ok = [r for r in summary if r.get("ok")]
    markers = sum(len(r["answerMarkers"]) for r in ok)
    thin_papers = [r for r in ok if r["thinSections"]]
    print(f"\nwrote {written} transcripts to {args.out}")
    print(f"{len(ok)}/{len(summary)} papers extracted, "
          f"{sum(r['charCount'] for r in ok):,} characters of dialogue")
    print(f"answer markers: {markers}/{len(ok) * 40} ({markers * 100 // max(1, len(ok) * 40)}%) — "
          f"Cambridge prints them in the page margin and MinerU drops many; the rest of the "
          f"transcript is still usable for dictation and review")
    print(f"{len(thin_papers)} papers have a section whose transcript did not split cleanly")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
