# -*- coding: utf-8 -*-
"""Stage 1 — map every (book, test, module, section) onto a MinerU byte range.

Why not just follow the headings? Because they are not reliable. A sweep over
all 18 books shows C06 emitting eight ``## LISTENING`` headings and only two
``## READING`` ones, while C05/C10/C12/C13 drop several outright, and C21
repeats ``## Test 1`` as a running page header. Segmenting on headings alone
mis-assigns whole papers.

What *is* reliable is the question numbering itself. Every paper numbers its
questions 1..40, so across the book the ``Questions a-b`` markers form eight
monotonically rising runs -- Listening 1, Reading 1, Listening 2, ... -- and a
run boundary is simply the point where the number drops. ``READING PASSAGE``
markers inside a run then confirm which module it is, rather than defining it.

Output: ``data-dev/repair/source-index.json``.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import (  # noqa: E402
    BOOKS,
    PASSAGE_RE,
    QUESTIONS_RANGE_RE,
    REPAIR,
    SECTION_RE,
    TRANSCRIPT_HEADING_RE,
    alnum_key,
    iter_questions,
    load_exam,
    load_markdown,
    mineru_markdown,
    squash,
    strip_tables,
    write_json,
)

# A "Questions 1-10" that appears mid-paragraph or inside an answer key is
# noise. Real markers sit on their own short line, optionally sharing it with
# the SECTION/PART heading -- and MinerU often drops the space, producing
# "## PART 1Questions 1-10", which is why the prefix is optional and loose.
MARKER_LINE_RE = re.compile(
    r"^[#\s]*(?:(?:SECTION|PART)\s*\d\s*)?Questions?\s*\d{1,2}\s*.{0,12}?\d{0,2}\s*$",
    re.I,
)


ANSWER_MARKER_RE = re.compile(r"\bQ\s?(\d{1,2})\b")


def find_transcript_start(text: str) -> int | None:
    """Where the audioscript appendix begins, by heading or by Q-marker density.

    C5 and C6 print "Tapescripts 127" only on the contents page -- the appendix
    title itself never made it through OCR. But the appendix is unmistakable in
    another way: Cambridge prints a ``Q1``..``Q40`` marker next to the line that
    contains each answer, and nothing else in the book does that. So when the
    heading is missing, fall back to the first place where those markers become
    dense.
    """
    for match in TRANSCRIPT_HEADING_RE.finditer(text):
        # The appendix always sits in the back of the book; an early hit is the
        # contents page.
        if match.start() >= len(text) * 0.4:
            return match.start()

    window = 20_000
    step = 2_000
    start = int(len(text) * 0.35)
    for probe in range(start, max(start, len(text) - window), step):
        distinct = {m.group(1) for m in ANSWER_MARKER_RE.finditer(text, probe, probe + window)}
        if len(distinct) >= 15:
            # Rewind to the section heading that opens this block.
            heads = list(SECTION_RE.finditer(text, max(0, probe - window), probe + 400))
            return heads[0].start() if heads else probe
    return None


def question_markers(text: str, limit: int) -> list[dict[str, Any]]:
    """Every plausible ``Questions a-b`` marker before ``limit``, in file order."""
    out: list[dict[str, Any]] = []
    for match in QUESTIONS_RANGE_RE.finditer(text, 0, limit):
        start, end = int(match.group(1)), int(match.group(2))
        if not 1 <= start <= 40 or not 1 <= end <= 40 or end < start:
            continue
        line_start = text.rfind("\n", 0, match.start()) + 1
        line_end = text.find("\n", match.end())
        line = text[line_start: line_end if line_end != -1 else len(text)]
        if not MARKER_LINE_RE.match(line.strip()):
            continue
        out.append({"first": start, "last": end, "pos": match.start(), "line": line.strip()})
    return out


def split_runs(markers: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Split the marker stream where the question number restarts."""
    runs: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    for marker in markers:
        # Strictly less-than: a "SECTION 1 Questions 1-10" heading is normally
        # followed by "Questions 1 and 2" for its first group, and an equality
        # test would tear every paper apart at its first sub-group.
        if current and marker["first"] < current[-1]["first"]:
            runs.append(current)
            current = []
        current.append(marker)
    if current:
        runs.append(current)
    return runs


def classify(text: str, run: list[dict[str, Any]], end: int) -> str:
    """Whichever structural marker opens the run decides the module.

    Counting markers over the whole run misfires: a listening run whose tail
    bleeds into the next reading paper picks up two READING PASSAGE hits and
    flips. The marker that comes *first* is the reliable signal. The window
    starts slightly before the first question marker because the
    SECTION/PART/PASSAGE heading usually sits just above it.
    """
    span_start = max(0, run[0]["pos"] - 400)
    span = text[span_start:end]
    passage = PASSAGE_RE.search(span)
    section = SECTION_RE.search(span)
    if passage and section:
        return "reading" if passage.start() < section.start() else "listening"
    if passage:
        return "reading"
    return "listening"


def widen_to_openings(text: str, papers: list[dict[str, Any]]) -> None:
    """Pull each paper's start back to its opening structural heading.

    A run begins at its first ``Questions a-b`` marker, but that marker sits
    *on* the ``## SECTION 1 Questions 1-10`` line (so `^` never matches inside
    the span) and, for reading, thousands of characters after ``## READING
    PASSAGE 1``. Without widening, section detection loses the first section of
    every paper and silently falls back to slicing the span into equal thirds.
    """
    for position, paper in enumerate(papers):
        floor = papers[position - 1]["end"] if position else 0
        pattern = PASSAGE_RE if paper["module"] == "reading" else SECTION_RE
        opening = None
        for match in pattern.finditer(text, floor, paper["start"] + 200):
            if match.group(1) == "1":
                opening = match.start()
        if opening is not None and opening < paper["start"]:
            paper["start"] = opening
            if position:
                papers[position - 1]["end"] = min(papers[position - 1]["end"], opening)


def passage_anchor(text: str, span_start: int, span_end: int, exam: dict[str, Any], index: int) -> int | None:
    """Find where a reading section's passage body ends inside the markdown.

    The importer only kept the passage in ``content.text`` and threw the
    question stems away, so for reading we have to re-enter the markdown after
    the passage. The tail of ``content.text`` is the anchor; OCR noise is
    absorbed by comparing on letters and digits only.
    """
    sections = exam.get("sections") or []
    if index >= len(sections):
        return None
    body = ((sections[index].get("content") or {}).get("text") or "")
    if len(body) < 200:
        return None
    haystack = text[span_start:span_end]
    flat = alnum_key(strip_tables(haystack))
    if not flat:
        return None
    # Map every position in `flat` back to an offset in `haystack`.
    positions: list[int] = []
    for offset, char in enumerate(strip_tables(haystack)):
        if char.isalnum() and char.isascii():
            positions.append(offset)
    for probe_len in (160, 120, 90, 60, 40):
        needle = alnum_key(body[-probe_len * 3:])[-probe_len:]
        if len(needle) < 20:
            continue
        hit = flat.rfind(needle)
        if hit == -1:
            continue
        last = hit + len(needle) - 1
        if last < len(positions):
            return span_start + positions[last]
    return None


def index_book(book: int) -> dict[str, Any]:
    text = load_markdown(book)
    transcript_start = find_transcript_start(text)
    limit = transcript_start if transcript_start is not None else len(text)
    markers = question_markers(text, limit)
    runs = split_runs(markers)

    papers: list[dict[str, Any]] = []
    for position, run in enumerate(runs):
        end = runs[position + 1][0]["pos"] if position + 1 < len(runs) else limit
        papers.append({
            "module": classify(text, run, end),
            "start": run[0]["pos"],
            "end": end,
            "markers": run,
        })
    widen_to_openings(text, papers)

    # Papers alternate listening/reading per test; pair them up in file order.
    listening = [p for p in papers if p["module"] == "listening"]
    reading = [p for p in papers if p["module"] == "reading"]
    entries: list[dict[str, Any]] = []
    for module, found in (("listening", listening), ("reading", reading)):
        for position, paper in enumerate(found):
            test = position + 1
            exam = load_exam(book, test, module) if test <= 4 else None
            entry = {
                "book": book,
                "test": test,
                "module": module,
                "examId": f"cambridge-{book}-test-{test}-{module}",
                "hasFixture": exam is not None,
                "start": paper["start"],
                "end": paper["end"],
                "markerCount": len(paper["markers"]),
                "markers": [{k: m[k] for k in ("first", "last", "pos")} for m in paper["markers"]],
                "sections": [],
                "extra": test > 4,
            }
            if exam is not None:
                entry["questionCount"] = sum(1 for _ in iter_questions(exam))
                entry["sections"] = section_ranges(text, paper, exam, module)
            entries.append(entry)
    return {
        "book": book,
        "markdown": str(mineru_markdown(book).relative_to(mineru_markdown(book).parents[3])),
        "transcriptStart": transcript_start,
        "paperCount": {"listening": len(listening), "reading": len(reading)},
        "papers": entries,
    }


def section_ranges(text: str, paper: dict[str, Any], exam: dict[str, Any], module: str) -> list[dict[str, Any]]:
    """Slice a paper into its 4 listening sections / 3 reading passages.

    Structural headings are the obvious slicing tool but they are only complete
    for 16% of sections across the corpus -- MinerU drops "READING PASSAGE 2"
    or renders "SECTION 3" as body text often enough that they cannot carry the
    load. The question markers can: the fixture already knows which question
    numbers belong to each section, and the markers say where those numbers
    appear. Headings are kept as a cross-check (`headingFound`).
    """
    span_start, span_end = paper["start"], paper["end"]
    marker_re = SECTION_RE if module == "listening" else PASSAGE_RE
    expected = 4 if module == "listening" else 3
    sections = exam.get("sections") or []

    # Question numbers per section, straight from the (trusted) answer key.
    ranges: list[tuple[int, int] | None] = []
    for section in sections[:expected]:
        numbers = sorted(
            q["number"] for g in section.get("questionGroups") or []
            for q in g.get("questions") or [] if isinstance(q.get("number"), int)
        )
        ranges.append((numbers[0], numbers[-1]) if numbers else None)
    while len(ranges) < expected:
        ranges.append(None)

    headings: dict[int, int] = {}
    for match in marker_re.finditer(text, span_start, span_end):
        index = int(match.group(1))
        if 1 <= index <= expected:
            headings.setdefault(index, match.start())

    markers = paper["markers"]
    starts: list[int] = []
    for position in range(expected):
        bounds = ranges[position]
        found = None
        if bounds is not None:
            lo = bounds[0]
            hit = next((m["pos"] for m in markers if m["first"] >= lo), None)
            # Prefer the heading when it sits just above the marker; it opens
            # the section's instruction block, which the parser wants.
            heading = headings.get(position + 1)
            if hit is not None and heading is not None and 0 <= hit - heading < 4000:
                found = heading
            elif hit is not None:
                found = hit
            elif heading is not None:
                found = heading
        if found is None:
            found = headings.get(position + 1)
        starts.append(found if found is not None else span_start + (span_end - span_start) * position // expected)

    # Enforce monotonicity so a stray hit cannot invert two sections.
    for position in range(1, expected):
        starts[position] = max(starts[position], starts[position - 1] + 1)
    starts[0] = min(starts[0], span_start) if starts[0] > span_start else starts[0]

    bounds_list: list[tuple[int, int]] = []
    for position, start in enumerate(starts):
        stop = starts[position + 1] if position + 1 < expected else span_end
        bounds_list.append((start, min(stop, span_end)))

    located = len(headings) == expected

    out: list[dict[str, Any]] = []
    for position, (start, stop) in enumerate(bounds_list):
        numbers = list(ranges[position]) if ranges[position] else []
        record: dict[str, Any] = {
            "index": position,
            "id": sections[position]["id"] if position < len(sections) else None,
            "start": start,
            "end": stop,
            "questionNumbers": [numbers[0], numbers[-1]] if numbers else None,
            "located": bool(numbers) and stop > start,
            "headingFound": position + 1 in headings,
            "allHeadingsFound": located,
        }
        if module == "reading":
            # The passage always comes first and the stems after it, so the
            # first "Questions a-b" marker inside the section is where the
            # question region opens. That beats anchoring on the tail of
            # content.text, which OCR noise and reflowed paragraphs often break.
            marker = next((m["pos"] for m in paper["markers"] if start <= m["pos"] < stop), None)
            anchor = passage_anchor(text, start, stop, exam, position)
            record["passageEnd"] = anchor
            record["questionStart"] = marker if marker is not None else (anchor if anchor is not None else start)
            record["questionStartFrom"] = "marker" if marker is not None else ("anchor" if anchor is not None else "sectionStart")
            # Cross-check: when both signals exist they should roughly agree.
            record["anchorFound"] = anchor is not None
            if anchor is not None and marker is not None:
                record["anchorMarkerGap"] = marker - anchor
            record["questionPreview"] = squash(text[record["questionStart"]: record["questionStart"] + 90])
        out.append(record)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--books", type=str, default="", help="e.g. 8,6 (default: all)")
    parser.add_argument("--out", type=Path, default=REPAIR / "source-index.json")
    args = parser.parse_args()
    books = [int(b) for b in args.books.split(",") if b.strip()] or list(BOOKS)

    index = {"schemaVersion": 1, "books": []}
    problems: list[str] = []
    for book in books:
        try:
            record = index_book(book)
        except FileNotFoundError as exc:
            problems.append(str(exc))
            continue
        index["books"].append(record)
        counts = record["paperCount"]
        # More than four is harmless -- the surplus comes from practice/answer
        # material after Test 4 and is tagged `extra`. Fewer than four means a
        # real paper was not located.
        if counts["listening"] < 4 and book in range(4, 21):
            problems.append(f"C{book:02d}: only {counts['listening']} listening papers found")
        if counts["reading"] < 4:
            problems.append(f"C{book:02d}: only {counts['reading']} reading papers found")
        if record["transcriptStart"] is None and book in range(4, 21):
            problems.append(f"C{book:02d}: no audioscript appendix found")

    index["problems"] = problems
    out = write_json(args.out, index)

    print(f"{'Book':<6}{'L':>3}{'R':>3}  {'transcript':>10}  {'R sections':>11}  located")
    for record in index["books"]:
        papers = [p for p in record["papers"] if not p["extra"]]
        sections = [s for p in papers if p["module"] == "reading" for s in p["sections"]]
        by_marker = sum(1 for s in sections if s.get("questionStartFrom") == "marker")
        located = sum(1 for p in papers for s in p["sections"] if s.get("located"))
        total = sum(len(p["sections"]) for p in papers)
        print(f"C{record['book']:02d}   {record['paperCount']['listening']:>3}"
              f"{record['paperCount']['reading']:>3}  "
              f"{'yes' if record['transcriptStart'] is not None else 'NO':>10}  "
              f"{by_marker:>4}/{len(sections):<6}  {located}/{total}")
    for line in problems:
        print(f"WARN {line}")
    print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
