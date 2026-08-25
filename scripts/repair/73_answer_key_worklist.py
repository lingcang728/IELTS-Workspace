# -*- coding: utf-8 -*-
"""Stage 7a — worklist for the printed answer key pages.

`69_fix_answer_keys.py` can reconcile the stored keys against the book's own
answer key, but it has almost nothing to reconcile against: of the 144 answer
blocks the corpus needs, MinerU recovered 66, and only 5 of those are complete.
The rest of the answer pages came through as scanned images. The books with the
worst extraction (C13 5/40, C18 6/40, C20 14/40) are exactly the ones holding
the questions stage 67 could not repair.

So the answer pages have to be read. That is transcription, and unlike the
option-text rounds it is **fully checkable by machine**: a block is exactly one
question range, the numbers run consecutively, and every answer has one of four
shapes. A model cannot quietly invent its way through it.

The strongest check is free: for every block we already have *some* answers from
the text extraction. A submission is asked for the whole block, and the answers
we already know become a built-in accuracy probe — disagree on those and the
submission is refused, without anyone having to sample it by hand.

    python scripts/repair/73_answer_key_worklist.py            # render + emit
    python scripts/repair/73_answer_key_worklist.py --status   # counts only
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MINERU = ROOT / "data-dev" / "mineru"
TASKS = ROOT / "data-dev" / "repair" / "answer-key-tasks"
RENDERS = ROOT / "data-dev" / "repair" / "renders" / "answer-keys"
RENDER_DPI = 150          # higher than the question pages: these are dense lists
RENDER_QUALITY = 80

ANSWER_KEY_RE = re.compile(r"listening and reading answer keys?", re.I)
COMPLETE = 38             # a block this full needs no transcription


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


stage69 = _load("stage69", "69_fix_answer_keys.py")


TEST_MARK_RE = re.compile(r"^TEST\s*(\d)\s*$", re.I)
MODULE_MARK_RE = re.compile(r"^(LISTENING|READING)\s*$", re.I)


def answer_key_pages(book: int) -> tuple[Path, list[int], dict[tuple[int, str], list[int]]] | None:
    """The PDF, the answer-key page range, and where each block sits inside it.

    The heading is a running header, so it repeats on every answer page — and it
    also appears once or twice in the contents at the front. Neither the first
    nor the last occurrence is the section: the section is the **longest
    contiguous run** of pages carrying it. (An earlier version took the last
    occurrence and landed on the section's final page.)

    Inside that run the `TEST n` and `LISTENING`/`READING` markers give each
    block its own page, which is the difference between asking a reviewer to
    read one page and asking them to read twenty.
    """
    lists = sorted(MINERU.glob(f"C{book:02d}/**/*_content_list.json"))
    pdfs = sorted(MINERU.glob(f"C{book:02d}/**/*_origin.pdf"))
    if not lists or not pdfs:
        return None
    blocks = json.loads(lists[0].read_text(encoding="utf-8"))
    marked = sorted({int(b.get("page_idx") or 0) for b in blocks
                     if ANSWER_KEY_RE.search(str(b.get("text") or ""))})
    if not marked:
        return None
    runs: list[list[int]] = [[marked[0]]]
    for page in marked[1:]:
        if page == runs[-1][-1] + 1:
            runs[-1].append(page)
        else:
            runs.append([page])
    pages = max(runs, key=len)
    if len(pages) < 2:
        return None

    where: dict[tuple[int, str], list[int]] = {}
    test = module = None
    for block in blocks:
        page = int(block.get("page_idx") or 0)
        if page < pages[0] or page > pages[-1]:
            continue
        text = str(block.get("text") or "").strip()
        if (m := TEST_MARK_RE.match(text)):
            test = int(m.group(1))
            continue
        if (m := MODULE_MARK_RE.match(text)):
            module = m.group(1).lower()
        if test and module:
            where.setdefault((test, module), []).append(page)
    # Keep each block to the pages it actually spans, de-duplicated and sorted.
    where = {k: sorted(set(v)) for k, v in where.items()}
    return pdfs[0], pages, where


def render(pdf: Path, pages: list[int], out_dir: Path) -> list[str]:
    import fitz  # PyMuPDF; imported late so --status works without it

    out_dir.mkdir(parents=True, exist_ok=True)
    document = fitz.open(pdf)
    written: list[str] = []
    for index in pages:
        if not 0 <= index < document.page_count:
            continue
        target = out_dir / f"p{index:04d}.jpg"
        if not target.exists():
            pixmap = document[index].get_pixmap(dpi=RENDER_DPI, colorspace=fitz.csGRAY)
            pixmap.pil_save(target, format="JPEG", quality=RENDER_QUALITY, optimize=True)
        written.append(str(target.relative_to(ROOT)).replace("\\", "/"))
    document.close()
    return written


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--status", action="store_true", help="count without rendering")
    parser.add_argument("--book", type=int, default=0)
    args = parser.parse_args()

    TASKS.mkdir(parents=True, exist_ok=True)
    books = [args.book] if args.book else list(range(4, 22))
    total_blocks = emitted = skipped = 0
    print(f"{'册':<5}{'区块':<7}{'已完整':<8}{'待抄写':<8}{'页数':<6}")
    for book in books:
        known = stage69.book_keys(book)
        wanted: list[tuple[int, str]] = [(t, m) for t in (1, 2, 3, 4)
                                         for m in ("listening", "reading")]
        if book == 21:                       # C21 has no listening papers at all
            wanted = [(t, "reading") for t in (1, 2, 3, 4)]
        pending = [(t, m) for t, m in wanted if len(known.get((t, m), {})) < COMPLETE]
        total_blocks += len(wanted)
        skipped += len(wanted) - len(pending)
        if not pending:
            print(f"C{book:02d}  {len(wanted):<7}{len(wanted):<8}{0:<8}{'-':<6}")
            continue
        located = answer_key_pages(book)
        if located is None:
            print(f"C{book:02d}  {len(wanted):<7}{len(wanted)-len(pending):<8}"
                  f"{len(pending):<8}{'找不到答案页':<6}")
            continue
        pdf, pages, where = located
        needed = sorted({p for t_, m_ in pending for p in where.get((t_, m_), pages)})
        images = [] if args.status else render(pdf, needed, RENDERS / f"C{book:02d}")
        by_page = {int(Path(i).stem[1:]): i for i in images}
        for test, module in pending:
            task = {
                "schemaVersion": 1,
                "taskId": f"cambridge-{book}-test-{test}-{module}-answerkey",
                "kind": "answer_key",
                "book": book,
                "test": test,
                "module": module,
                "examId": f"cambridge-{book}-test-{test}-{module}",
                "expectedRange": [1, 40],
                "pdf": str(pdf.relative_to(ROOT)).replace("\\", "/"),
                "pdfPagesZeroBased": where.get((test, module), pages),
                "images": [by_page[p] for p in where.get((test, module), pages) if p in by_page],
                # Everything the text extraction already recovered. The submission
                # must agree with every one of these or it is refused.
                "knownAnswers": {str(n): v for n, v in sorted(known.get((test, module), {}).items())},
            }
            (TASKS / f"{task['taskId']}.task.json").write_text(
                json.dumps(task, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            emitted += 1
        spans = [len(where.get(k, pages)) for k in pending]
        print(f"C{book:02d}  {len(wanted):<7}{len(wanted)-len(pending):<8}"
              f"{len(pending):<8}{f'每单 {min(spans)}-{max(spans)} 页':<6}")

    print(f"\n共 {total_blocks} 个区块 · 已完整 {skipped} · 生成工单 {emitted}")
    print(f"工单 → {TASKS}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
