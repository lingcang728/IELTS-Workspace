# -*- coding: utf-8 -*-
"""Stage 1b — map every question to the PDF page it is printed on.

MinerU writes ``*_content_list.json`` beside the markdown, and every block in
it carries a ``page_idx``. The markdown is generated from those same blocks in
order, so walking both with a monotonic cursor gives a
``markdown offset -> PDF page`` map, and therefore a
``(exam, question) -> PDF page`` map.

That is what makes proofreading against the original tractable: instead of
trusting OCR, the page can simply be rendered and read.

Output: ``data-dev/repair/page-map.json``.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import (  # noqa: E402
    BOOKS,
    MINERU_ROOT,
    REPAIR,
    alnum_key,
    load_exam,
    load_markdown,
    mineru_markdown,
    read_json,
    write_json,
)


def content_list(book: int) -> list[dict[str, Any]]:
    base = MINERU_ROOT / f"C{book:02d}"
    hits = sorted(base.glob("*/auto/*_content_list.json")) + \
        sorted(base.glob("*/hybrid_auto/*_content_list.json"))
    if not hits:
        return []
    return read_json(max(hits, key=lambda p: p.stat().st_size))


def block_text(block: dict[str, Any]) -> str:
    for key in ("text", "content", "table_body", "table_caption", "image_caption"):
        value = block.get(key)
        if isinstance(value, str) and value.strip():
            return value
        if isinstance(value, list) and value:
            joined = " ".join(str(v) for v in value if v)
            if joined.strip():
                return joined
    return ""


def longest_monotonic(pairs: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Keep the longest subsequence whose page numbers never go backwards.

    Blocks are matched independently, so a repeated running header or a
    duplicated sentence can anchor to the wrong place. Since ``page_idx`` only
    ever increases through the book, sorting the hits by markdown offset and
    keeping the longest non-decreasing run by page discards those outliers
    without needing to know which ones they were.
    """
    if not pairs:
        return []
    pairs = sorted(pairs)
    best_length = [1] * len(pairs)
    previous = [-1] * len(pairs)
    for index in range(len(pairs)):
        for earlier in range(index):
            if pairs[earlier][1] <= pairs[index][1] and best_length[earlier] + 1 > best_length[index]:
                best_length[index] = best_length[earlier] + 1
                previous[index] = earlier
    tail = max(range(len(pairs)), key=lambda i: best_length[i])
    chain: list[tuple[int, int]] = []
    while tail != -1:
        chain.append(pairs[tail])
        tail = previous[tail]
    return list(reversed(chain))


def build_offset_pages(book: int) -> list[tuple[int, int]]:
    """[(markdown_offset, page_idx), ...] sorted by offset."""
    markdown = load_markdown(book)
    flat = alnum_key(markdown)
    # Position i in `flat` maps back to `positions[i]` in the markdown.
    positions = [index for index, char in enumerate(markdown)
                 if char.isalnum() and char.isascii()]
    candidates: list[tuple[int, int]] = []
    for block in content_list(book):
        page = block.get("page_idx")
        if page is None:
            continue
        probe = alnum_key(block_text(block))[:70]
        if len(probe) < 20:
            continue
        hit = flat.find(probe)
        # An ambiguous probe (a running header, a repeated sentence) is not an
        # anchor at all.
        if hit == -1 or flat.find(probe, hit + 1) != -1:
            continue
        if hit < len(positions):
            candidates.append((positions[hit], int(page)))
    return longest_monotonic(candidates)


DASH_ALTS = "|".join(["-", "‐", "‑", "‒", "–", "—", "―",
                       "−", "－", "一", "and", "to", "&"])


def build_heading_pattern(low: int, high: int) -> re.Pattern[str]:
    """Match a printed "Questions a-b" heading, dash variants included."""
    return re.compile(
        r"Questions?\s*0?" + str(low) + r"\s*(?:" + DASH_ALTS + r")\s*0?" + str(high) + r"(?!\d)",
        re.I,
    )


HEADING_SEARCH_RADIUS = 6


def heading_page(blocks: list[dict[str, Any]], group_range: tuple[int, int] | None,
                 bracket: tuple[int, int]) -> int | None:
    """Exact page of a group's "Questions a-b" heading, if it is unambiguous.

    The same heading text appears in all eight papers of a book, so the search
    is confined to a few pages either side of the interpolated bracket. A hit
    is only used when it is the single candidate in that window.
    """
    if not group_range:
        return None
    low, high = group_range
    pattern = build_heading_pattern(low, high)
    lo_page = bracket[0] - HEADING_SEARCH_RADIUS
    hi_page = bracket[1] + HEADING_SEARCH_RADIUS
    hits = {
        int(block["page_idx"])
        for block in blocks
        if block.get("page_idx") is not None
        and lo_page <= int(block["page_idx"]) <= hi_page
        and pattern.search(block_text(block))
    }
    return hits.pop() if len(hits) == 1 else None


def page_for(offset_pages: list[tuple[int, int]], offset: int) -> tuple[int, int] | None:
    """The page range `offset` must lie in: [page before it, page after it].

    A single number would be a floor estimate and is wrong whenever the block
    carrying the anchor was itself too ambiguous to match -- the answer then
    falls back to the previous page. Bracketing between the nearest anchored
    block on each side is honest, and collapses to a single page whenever the
    anchors are tight, which is the common case.
    """
    if not offset_pages:
        return None
    low, high = 0, len(offset_pages)
    while low < high:
        mid = (low + high) // 2
        if offset_pages[mid][0] <= offset:
            low = mid + 1
        else:
            high = mid
    before = offset_pages[low - 1][1] if low else offset_pages[0][1]
    after = offset_pages[low][1] if low < len(offset_pages) else before
    return (min(before, after), max(before, after))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--books", type=str, default="")
    parser.add_argument("--index", type=Path, default=REPAIR / "source-index.json")
    parser.add_argument("--out", type=Path, default=REPAIR / "page-map.json")
    args = parser.parse_args()
    index = read_json(args.index)
    books = [int(b) for b in args.books.split(",") if b.strip()] or list(BOOKS)

    payload: dict[str, Any] = {"schemaVersion": 1, "exams": {}}
    print(f"{'Book':<6}{'blocks':>8}{'anchored':>10}{'pages':>8}  coverage")
    for book in books:
        record = next((b for b in index["books"] if b["book"] == book), None)
        if record is None:
            continue
        offset_pages = build_offset_pages(book)
        blocks = content_list(book)
        pages = sorted({page for _offset, page in offset_pages})
        markdown = load_markdown(book)
        # Question markers give the page for each question group.
        for paper in record["papers"]:
            if paper["extra"] or not paper.get("sections"):
                continue
            exam = load_exam(book, paper["test"], paper["module"])
            if exam is None:
                continue
            per_question: dict[str, int] = {}
            for position, section in enumerate(paper["sections"]):
                if position >= len(exam["sections"]):
                    break
                start = section.get("questionStart", section["start"])
                # Distribute the section's questions over its markers so that a
                # group printed on the next page gets that page, not the first.
                markers = [m for m in paper["markers"] if start <= m["pos"] < section["end"]]
                for group in exam["sections"][position].get("questionGroups") or []:
                    for question in group.get("questions") or []:
                        number = question.get("number")
                        # The fixture's own groups are unreliable -- the importer
                        # merged many of them into one 40-question group, so its
                        # range is (1,40) and matches no printed heading. The
                        # markdown's "Questions a-b" markers carry the real
                        # printed ranges.
                        marker = next((m for m in markers
                                       if m["first"] <= number <= m["last"]), None)
                        anchor = marker["pos"] if marker else start
                        group_range = (marker["first"], marker["last"]) if marker else None
                        bracket = page_for(offset_pages, anchor)
                        if bracket is None:
                            continue
                        # Interpolation only brackets the page. When the group's
                        # own "Questions a-b" heading survives as a content block
                        # its page_idx is exact, so prefer that -- searched near
                        # the bracket, because the identical heading appears in
                        # all eight papers of the book.
                        exact = heading_page(blocks, group_range, bracket)
                        per_question[question["id"]] = [exact, exact] if exact is not None else list(bracket)
            payload["exams"][paper["examId"]] = {
                "book": book,
                "test": paper["test"],
                "module": paper["module"],
                "pdf": f"教材/{mineru_markdown(book).stem}.pdf",
                "questionPages": per_question,
            }
        covered = sum(len(e["questionPages"]) for e in payload["exams"].values()
                      if e["book"] == book)
        expected = sum(40 for p in record["papers"] if not p["extra"] and p.get("sections"))
        print(f"C{book:02d}  {len(blocks):>8}{len(offset_pages):>10}{len(pages):>8}  "
              f"{covered}/{expected} questions, markdown {len(markdown):,} chars")

    out = write_json(args.out, payload)
    total = sum(len(e["questionPages"]) for e in payload["exams"].values())
    exact = sum(1 for e in payload["exams"].values()
                for bounds in e["questionPages"].values() if bounds[0] == bounds[1])
    widths = [b[1] - b[0] + 1 for e in payload["exams"].values()
              for b in e["questionPages"].values()]
    pages = sum(len({p for b in e["questionPages"].values() for p in range(b[0], b[1] + 1)})
                for e in payload["exams"].values())
    print(f"\n{total} questions mapped; {exact} ({exact * 100 // max(1, total)}%) land on a single page")
    if widths:
        print(f"page window: mean {sum(widths) / len(widths):.2f} pages, worst {max(widths)}")
    print(f"~{pages} (exam, page) pairs to render → {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
