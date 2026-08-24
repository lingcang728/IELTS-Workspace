# -*- coding: utf-8 -*-
"""Stage 12 — rebuild the reading passages the importer lost.

Twelve reading papers ship with an empty passage pane, or with the same blob
of text in all three sections. The text is not missing from the source: it is
in the MinerU markdown, but `00_index_sources.py` segments a book by runs of
question numbers, and a reading passage contains no question numbers. So each
paper's span begins at its *questions*, and the passage that precedes them is
swallowed by the paper before it.

The fix needs no OCR and no page reading. Cambridge prints an exact boundary
before every passage:

    You should spend about 20 minutes on Questions 1-13, which are based on
    Reading Passage 1 below.

The three lead-ins inside one paper's window are, in document order, Passages
1, 2 and 3 -- which stays right even when OCR has mangled the words saying
which passage it is.

Two layouts have to be told apart. Usually the passage follows the lead-in
directly. When the lead-in ends "on the following pages" the questions are
printed first, so the passage is a later block in that region; there, the
block carrying the most paragraph text wins and its leading rubric is trimmed.

Nothing is written unless it passes `assess`: long enough to be a passage,
not so long that it swallowed the questions, distinct from its siblings, and
free of watermark text.

    python scripts/repair/66_resplit_passages.py                 # report only
    python scripts/repair/66_resplit_passages.py --apply
    python scripts/repair/66_resplit_passages.py --all --apply   # every reading paper
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import BOOKS, FIXTURES, REPAIR, load_markdown, read_json, write_json  # noqa: E402

# "You should spend about 20 minutes on Questions 1-13, which are based on
# Reading Passage 1 below."
#
# Only the opening clause is required. Demanding the question range too costs
# real coverage -- C20's official scan keeps "You should spend" 11 times but
# the full sentence only twice -- and the range is not needed anyway: the
# lead-ins inside one paper's window are Passages 1, 2, 3 in document order.
LEAD_RE = re.compile(r"You\s+sh\w*\s+sp\w*\s+ab\w*\s+20[^\n]*", re.I)
# The writing paper uses the same opening ("You should spend about 20 minutes
# on this task"), so anything naming a task is not a passage lead-in.
WRITING_LEAD_RE = re.compile(r"\bthis task\b|\bTask\s*[12]\b", re.I)
# Second anchor, for books whose OCR lost the lead-in sentence: a standalone
# "READING PASSAGE 2" banner. It must be the whole line -- "Reading Passage 2
# has seven sections, A-G" is a question rubric, not a passage banner.
BANNER_RE = re.compile(r"^#{0,4}\s*\**\s*READING\s+PASSAGE\s*[123]?\s*\**\s*$", re.I | re.M)
# The first question number after an anchor says which passage it introduces:
# Academic Reading is always 1-13 / 14-26 / 27-40.
QNUM_RE = re.compile(r"^#{0,4}\s*\**\s*Questions?\s*(\d{1,2})", re.I | re.M)
# A printed "Questions a-b" group heading: where a passage stops.
QHEAD_RE = re.compile(r"^#{0,4}\s*\**\s*Questions?\s*\d{1,2}\s*(?:[-–—]|and)\s*\d{1,2}",
                      re.I | re.M)
# A lead-in pointing at a later page rather than the text below it.
CONTINUES_RE = re.compile(r"following pages?|next page", re.I)
IMAGE_LINE_RE = re.compile(r"^\s*!\[\]\([^)]*\)\s*$")
# Lines that open question material rather than passage prose.
QUESTION_LINE_RE = re.compile(
    r"^(#{0,4}\s*)?(Questions?\b|List of [Hh]eadings|Reading Passage \d+ (has|contains)"
    r"|Choose |Write |Do the following|Complete |Which paragraph|Which section|Label "
    r"|Answer the|Classify|Match |NB\b|TRUE\b|FALSE\b|YES\b|NOT GIVEN)", re.I)

WATERMARKS = ("沪江", "学习交流", "建议购买正版", "仅供学习", "扫描二维码",
              "www.", "更多资料", "版权所有", "未经许可", "TopSage", "大家网",
              "hjenglish", "留学")
MIN_PASSAGE = 1500
# A Cambridge Academic passage runs roughly 700-1000 words; well past this and
# the slice has swallowed the questions or the next passage as well.
MAX_PASSAGE = 12000
# A line at least this long is a paragraph, not a question item or an option.
PARAGRAPH_CHARS = 140


def clean(text: str) -> str:
    """Strip what is on the page but not in the passage.

    Image lines are MinerU's figure placeholders, and the scanned copies of
    C06/C07 carry a pirate-site watermark on every page. Both have to go: the
    gate treats a watermark inside section text as a fatal error, and rightly.
    """
    lines = []
    for line in text.split("\n"):
        if IMAGE_LINE_RE.match(line):
            continue
        if any(mark.lower() in line.lower() for mark in WATERMARKS):
            continue
        lines.append(line)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def prose_chars(text: str) -> int:
    """Characters living in paragraph-shaped lines.

    A question block is short numbered lines; a passage is long paragraphs.
    Scoring on paragraph text separates them without having to enumerate every
    question layout Cambridge uses.
    """
    return sum(len(line) for line in text.split("\n") if len(line.strip()) >= PARAGRAPH_CHARS)


def question_blocks(markdown: str, low: int, high: int) -> list[str]:
    """`markdown[low:high]` cut at every printed "Questions a-b" heading."""
    cuts = [low] + [m.start() for m in QHEAD_RE.finditer(markdown, low, high)] + [high]
    out: list[str] = []
    for start, stop in zip(cuts, cuts[1:]):
        segment = markdown[start:stop]
        if start != low:                       # drop the heading line itself
            segment = re.sub(r"^[^\n]*\n", "", segment, count=1)
        out.append(clean(segment))
    return out


def trim_to_passage(block: str) -> str:
    """Drop question rubric printed above the passage inside one block.

    When the questions come first, the block that wins on prose density still
    opens with "Choose the correct heading ..." or with the worked-example
    table. The passage starts at its own title, or failing that at its first
    real paragraph.
    """
    lines = block.split("\n")

    def is_prose(line: str) -> bool:
        stripped = line.strip()
        # A worked-example table ("Example | Paragraph A | Answer viii") is one
        # very long line, so length alone would mistake it for a paragraph.
        if stripped.startswith("<table") or stripped.startswith("|"):
            return False
        if QUESTION_LINE_RE.match(stripped):
            return False
        return len(stripped) >= PARAGRAPH_CHARS

    first = next((i for i, line in enumerate(lines) if is_prose(line)), None)
    if first is None:
        return block
    start = first
    for index in range(first - 1, max(-1, first - 6), -1):
        stripped = lines[index].strip()
        if not stripped:
            continue
        if stripped.startswith("#") and not QUESTION_LINE_RE.match(stripped):
            start = index
        break
    return "\n".join(lines[start:]).strip()


def passage_slices(markdown: str, low: int, high: int) -> list[dict[str, Any]]:
    """The passages printed in `markdown[low:high]`, in document order."""
    leads = [m for m in LEAD_RE.finditer(markdown, low, high)
             if not WRITING_LEAD_RE.search(m.group(0))]
    # C20's official scan and C09 Test 4 lost most lead-in sentences to OCR.
    # Fall back to the passage banner, keeping whichever anchor comes first
    # when both survive for the same passage.
    if len(leads) < 3:
        anchors = list(leads) + list(BANNER_RE.finditer(markdown, low, high))
        anchors.sort(key=lambda m: m.start())
        merged: list[Any] = []
        for anchor in anchors:
            if merged and anchor.start() - merged[-1].end() < 400:
                continue
            merged.append(anchor)
        leads = merged
    out: list[dict[str, Any]] = []
    for index, lead in enumerate(leads):
        stop = leads[index + 1].start() if index + 1 < len(leads) else high
        blocks = question_blocks(markdown, lead.end(), stop)
        direct = blocks[0] if blocks else ""
        if prose_chars(direct) >= MIN_PASSAGE:
            text = direct
        elif blocks:
            text = trim_to_passage(max(blocks, key=prose_chars))
        else:
            text = ""
        # Whichever route produced it, the text must open like a passage.
        text = trim_to_passage(text) if text else ""
        out.append({
            "leadAt": lead.start(),
            "lead": lead.group(0)[:80],
            "continues": bool(CONTINUES_RE.search(lead.group(0))),
            "slot": slot_for(markdown, lead.end(), high),
            "text": text,
        })
    return out


def slot_for(markdown: str, start: int, high: int) -> int | None:
    """Which of Passage 1/2/3 the anchor at `start` introduces, or None.

    Reading the first question number after the anchor beats counting anchors
    in document order: when OCR has eaten one banner entirely, counting shifts
    every later passage into the wrong section, while this leaves the missing
    one empty and puts the others where they belong.
    """
    match = QNUM_RE.search(markdown, start, high)
    if not match:
        return None
    number = int(match.group(1))
    if 1 <= number <= 13:
        return 0
    if 14 <= number <= 26:
        return 1
    if 27 <= number <= 40:
        return 2
    return None


def assess(text: str, siblings: list[str]) -> str | None:
    """None when the slice is usable, else the reason it is not."""
    if len(text) < MIN_PASSAGE:
        return f"only {len(text)} characters"
    if len(text) > MAX_PASSAGE:
        return f"{len(text)} characters — the slice ran past the passage"
    if prose_chars(text) < MIN_PASSAGE:
        return f"only {prose_chars(text)} characters of paragraph text — this is a question block"
    for mark in WATERMARKS:
        if mark.lower() in text.lower():
            return f"contains watermark text {mark!r}"
    if text in siblings:
        return "identical to another passage in the same paper"
    return None


def reading_papers(index: dict[str, Any], book: int) -> list[dict[str, Any]]:
    record = next((b for b in index["books"] if b["book"] == book), None)
    if record is None:
        return []
    papers = [p for p in record["papers"] if p["module"] == "reading" and not p["extra"]]
    return sorted(papers, key=lambda p: p["start"])


def section_text(section: dict[str, Any]) -> str:
    return str((section.get("content") or {}).get("text") or "").strip()


LISTENING_MARKER_RE = re.compile(r"^\s*SECTION\s*[1-4]", re.M | re.I)


def needs_repair(exam: dict[str, Any]) -> bool:
    """Same definition of broken the gate uses, so the two never disagree."""
    texts = [section_text(s) for s in exam.get("sections") or []]
    if any(len(t) < MIN_PASSAGE or len(t) > MAX_PASSAGE for t in texts):
        return True
    if any(LISTENING_MARKER_RE.search(t) for t in texts):
        return True
    return len(texts) > 1 and len(set(texts)) == 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--books", type=str, default="")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--all", action="store_true",
                        help="consider every reading paper, not only the broken ones")
    parser.add_argument("--out", type=Path, default=REPAIR / "passage-resplit.json")
    args = parser.parse_args()

    index = read_json(REPAIR / "source-index.json")
    books = [int(b) for b in args.books.split(",") if b.strip()] or list(BOOKS)
    results: list[dict[str, Any]] = []
    counts = {"exams": 0, "sectionsFilled": 0, "sectionsLeft": 0, "examsTouched": 0,
              "skipped": 0}

    for book in books:
        markdown_cache: str | None = None
        papers = reading_papers(index, book)
        for position, paper in enumerate(papers):
            path = FIXTURES / f"{paper['examId']}.json"
            if not path.exists():
                continue
            exam = read_json(path)
            if not args.all and not needs_repair(exam):
                counts["skipped"] += 1
                continue
            counts["exams"] += 1
            if markdown_cache is None:
                markdown_cache = load_markdown(book)
            markdown = markdown_cache

            # Passage 1 sits *before* this paper's question span, inside what
            # the index handed to the paper before it. The previous reading
            # paper's end is the safe lower bound: no passage of test N can
            # precede the questions of test N-1.
            low = papers[position - 1]["end"] if position else 0
            found = passage_slices(markdown, low, paper["end"])
            sections = exam.get("sections") or []
            # Place each slice in the section its question numbers name. Fall
            # back to document order only when every slice agrees with it, so
            # a lost banner leaves a hole instead of shifting the rest.
            slices: list[dict[str, Any]] = [{"text": ""} for _ in sections]
            by_slot = [s for s in found if s.get("slot") is not None]
            slot_mapped = bool(by_slot) and len({s["slot"] for s in by_slot}) == len(by_slot)
            if slot_mapped:
                for entry in by_slot:
                    if entry["slot"] < len(slices):
                        slices[entry["slot"]] = entry
            else:
                for index, entry in enumerate(found[:len(sections)]):
                    slices[index] = entry
            record: dict[str, Any] = {"exam": paper["examId"], "found": len(slices),
                                      "passages": []}

            # A complete extraction — one usable passage for every section —
            # is trusted over whatever is in the fixture. An earlier run with
            # fewer anchors could have written the right text into the wrong
            # slot, and only a complete run can tell.
            complete = all(assess(s.get("text", ""), []) is None for s in slices)

            # Existing good passages count as siblings so a partial re-run
            # cannot write a duplicate of one that is already correct.
            # When the slices were placed by question number, that placement is
            # authoritative: existing content must not veto it as a "duplicate",
            # because the duplicate is usually the same passage sitting in the
            # wrong section from an earlier, blinder run.
            siblings = ([] if (complete or slot_mapped) else
                        [section_text(s) for s in sections if len(section_text(s)) >= MIN_PASSAGE])
            changed = False
            for slot, section in enumerate(sections):
                current = section_text(section)
                text = slices[slot]["text"] if slot < len(slices) else ""
                reason = assess(text, siblings) if text else "no lead-in found for this passage"
                healthy = (not complete and not slot_mapped
                           and len(current) >= MIN_PASSAGE
                           and current not in siblings[:slot])
                write = reason is None and (not healthy) and current != text
                if write:
                    siblings.append(text)
                    counts["sectionsFilled"] += 1
                    if args.apply:
                        section.setdefault("content", {})["format"] = "plain"
                        section["content"]["text"] = text
                        changed = True
                already = reason is None and current == text
                if not write and not healthy and not already:
                    counts["sectionsLeft"] += 1
                record["passages"].append({
                    "section": section.get("id"),
                    "chars": len(text),
                    "action": "fill" if write else ("keep" if healthy or already else "leave"),
                    "reason": reason,
                    "head": text[:70],
                })

            if slot_mapped:
                # A section with no slice of its own must not keep text that
                # another section is now claiming: showing Passage 3 under the
                # Passage 1 tab is worse than showing nothing, and the gate
                # reports the blank so it stays visible.
                written = {s["text"] for s in slices if s.get("text")}
                for slot, section in enumerate(sections):
                    if slices[slot].get("text"):
                        continue
                    if section_text(section) in written:
                        if args.apply:
                            section.setdefault("content", {})["text"] = ""
                            changed = True
                        record["passages"][slot]["action"] = "clear"
                        record["passages"][slot]["reason"] = (
                            "held another section's passage; cleared so the gap stays visible")

            if args.apply and changed:
                backup = path.with_suffix(".json.bak")
                if not backup.exists():
                    backup.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
                filled = sum(1 for p in record["passages"] if p["action"] == "fill")
                exam["contentRevision"] = f"resplit-{filled:02d}-{paper['examId'][-14:]}"
                path.write_text(json.dumps(exam, ensure_ascii=False, indent=2) + "\n",
                                encoding="utf-8")
                counts["examsTouched"] += 1
            results.append(record)

    write_json(args.out, {"schemaVersion": 1, "counts": counts, "exams": results})
    print(json.dumps(counts, ensure_ascii=False))
    for record in results:
        left = sum(1 for p in record["passages"] if p["action"] == "leave")
        print(f"{'OK   ' if not left else 'PART '} {record['exam']:<32} lead-ins {record['found']}")
        for entry in record["passages"]:
            mark = {"fill": "fill", "keep": "keep", "leave": "LEFT", "clear": "CLR "}[entry["action"]]
            tail = "" if entry["action"] in ("fill", "keep") else f"  ← {entry['reason']}"
            print(f"        {mark} {entry['section']:<4} {entry['chars']:>6} chars{tail}")
    print(f"\nreport → {args.out}")
    if not args.apply:
        print("(report only; rerun with --apply to write)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
