# -*- coding: utf-8 -*-
"""Attach MinerU-extracted map/plan/diagram images to labelling groups.

The gate reports a labelling group as a content gap when its rubric says
"Label the map/plan/diagram/chart" (or a question is typed ``labelling``) but
neither the group nor its section references an image. MinerU already cut
images out of the same PDF pages the page-map assigned to those questions —
this script pairs them.

Confidence:
  HIGH   — the page-map page also has a "Label the …" line in MinerU text,
           and a large image sits on that page.
  MEDIUM — large image on the page-map page, no matching rubric line (OCR
           often drops italic instructions).
  SKIP   — no image above the size floor, or the pages are the known missing
           C13 T3 Listening scans.

Default writes HIGH only. ``--include-medium`` adds MEDIUM. Never writes
``fixtures/overlays/``. Each changed exam gets a ``.bak``.

    python scripts/repair/79_attach_map_images.py            # report
    python scripts/repair/79_attach_map_images.py --apply
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import BOOKS, FIXTURES, REPAIR, ROOT, mineru_markdown, read_json, write_json  # noqa: E402

LABEL_RUBRIC_RE = re.compile(r"\blabel\s+the\s+(map|plan|diagram|chart)\b", re.I)
IMAGE_REF_RE = re.compile(r"!\[[^\]]*\]\([^)]+\)|[\w./-]+\.(?:jpe?g|png|gif|svg|webp)", re.I)
# MinerU bbox is roughly a 1000-wide page. Logos/watermarks sit well under this.
MIN_BBOX_AREA = 70_000
MIN_FILE_BYTES = 12_000
# The page-map often pins a labelling question to the notes page above the
# map. The picture itself is on the next (sometimes previous) PDF page.
PAGE_NEIGHBOR = 1
ASSETS = ROOT / "fixtures" / "assets" / "cambridge"
PAGE_MAP = REPAIR / "page-map.json"
REPORT = REPAIR / "map-attach-report.json"
# Printed pages 54–55 of C13 Test 3 Listening were never in the PDF.
SKIP_EXAMS = {"cambridge-13-test-3-listening"}


def is_labelling(group: dict[str, Any]) -> bool:
    if any(q.get("type") == "labelling" for q in group.get("questions") or []):
        return True
    return bool(LABEL_RUBRIC_RE.search(str(group.get("instruction") or "")))


def has_image(group: dict[str, Any], section: dict[str, Any]) -> bool:
    for holder in (group, section):
        if IMAGE_REF_RE.search(json.dumps(holder, ensure_ascii=False)):
            return True
    return False


def content_list_path(book: int) -> Path | None:
    md = mineru_markdown(book)
    hits = sorted(
        p for p in md.parent.glob("*_content_list.json")
        if "_v2" not in p.name
    )
    return hits[0] if hits else None


def load_mineru_pages(book: int) -> dict[int, dict[str, Any]]:
    """page_idx → {texts, images:[{path, area, bbox, bytes}]}"""
    path = content_list_path(book)
    if path is None:
        return {}
    items = json.loads(path.read_text(encoding="utf-8"))
    pages: dict[int, dict[str, Any]] = defaultdict(lambda: {"texts": [], "images": []})
    base = path.parent
    for item in items:
        page = item.get("page_idx")
        if not isinstance(page, int):
            continue
        if item.get("type") == "text":
            pages[page]["texts"].append(str(item.get("text") or ""))
            continue
        if item.get("type") != "image":
            continue
        rel = item.get("img_path") or ""
        img = (base / rel).resolve()
        if not img.exists():
            continue
        bbox = item.get("bbox") or [0, 0, 0, 0]
        try:
            area = abs((bbox[2] - bbox[0]) * (bbox[3] - bbox[1]))
        except (TypeError, IndexError):
            area = 0
        pages[page]["images"].append({
            "path": img,
            "area": area,
            "bbox": bbox,
            "bytes": img.stat().st_size,
        })
    return pages


def load_page_map() -> dict[str, dict[str, list[int]]]:
    if not PAGE_MAP.exists():
        return {}
    data = read_json(PAGE_MAP)
    out: dict[str, dict[str, list[int]]] = {}
    for exam_id, rec in (data.get("exams") or {}).items():
        pages = rec.get("questionPages") or {}
        out[exam_id] = {
            qid: [int(a), int(b)] for qid, (a, b) in pages.items()
            if isinstance(a, int) and isinstance(b, int)
        }
    return out


def group_pages(exam_id: str, group: dict[str, Any], pagemap: dict[str, dict[str, list[int]]]) -> list[int]:
    pages: set[int] = set()
    exam_pages = pagemap.get(exam_id) or {}
    for q in group.get("questions") or []:
        span = exam_pages.get(str(q.get("id") or ""))
        if not span:
            continue
        lo, hi = span
        for p in range(min(lo, hi), max(lo, hi) + 1):
            pages.add(p)
    return sorted(pages)


def search_pages(mapped: list[int]) -> list[int]:
    pages: set[int] = set()
    for page in mapped:
        for delta in range(-PAGE_NEIGHBOR, PAGE_NEIGHBOR + 1):
            candidate = page + delta
            if candidate >= 0:
                pages.add(candidate)
    return sorted(pages)


def pick_image(page_info: dict[str, Any]) -> dict[str, Any] | None:
    candidates = [
        img for img in page_info.get("images") or []
        if img["area"] >= MIN_BBOX_AREA and img["bytes"] >= MIN_FILE_BYTES
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda img: (img["area"], img["bytes"]))


def page_has_label_text(page_info: dict[str, Any]) -> bool:
    blob = "\n".join(page_info.get("texts") or [])
    return bool(LABEL_RUBRIC_RE.search(blob))


def dest_rel(book: int, test: int, module: str, page: int) -> str:
    return f"assets/cambridge/c{book:02d}-t{test}-{module}-p{page:04d}.jpg"


def iter_labelling_gaps(pagemap: dict[str, dict[str, list[int]]]):
    for path in sorted(FIXTURES.glob("cambridge-*-test-*-*.json")):
        exam = json.loads(path.read_text(encoding="utf-8"))
        exam_id = str(exam.get("id") or "")
        module = exam.get("module")
        if module not in {"listening", "reading"}:
            continue
        parts = exam_id.split("-")
        # cambridge-{book}-test-{test}-{module}
        try:
            book = int(parts[1])
            test = int(parts[3])
        except (IndexError, ValueError):
            continue
        for section in exam.get("sections") or []:
            for group in section.get("questionGroups") or []:
                if not is_labelling(group) or has_image(group, section):
                    continue
                yield {
                    "path": path,
                    "exam": exam,
                    "examId": exam_id,
                    "book": book,
                    "test": test,
                    "module": module,
                    "section": section,
                    "group": group,
                    "pages": group_pages(exam_id, group, pagemap),
                    "numbers": [q.get("number") for q in group.get("questions") or []],
                    "instruction": str(group.get("instruction") or "")[:80],
                }


def classify(row: dict[str, Any], mineru: dict[int, dict[int, dict[str, Any]]]) -> dict[str, Any]:
    if row["examId"] in SKIP_EXAMS:
        return {**row, "confidence": "SKIP", "reason": "known missing scans"}
    pages_data = mineru.get(row["book"]) or {}
    if not row["pages"]:
        return {**row, "confidence": "SKIP", "reason": "no page-map entry"}
    candidates: list[tuple[bool, int, int, dict[str, Any]]] = []
    for page in search_pages(row["pages"]):
        info = pages_data.get(page) or {"texts": [], "images": []}
        labelled = page_has_label_text(info)
        picked = pick_image(info)
        if picked is None:
            continue
        candidates.append((labelled, picked["area"], page, picked))
    if not candidates:
        return {**row, "confidence": "SKIP", "reason": "no large MinerU image on mapped pages ±1"}
    labelled, area, best_page, best = max(candidates, key=lambda row_: (row_[0], row_[1]))
    conf = "HIGH" if labelled else "MEDIUM"
    return {
        **row,
        "confidence": conf,
        "reason": "label rubric on page" if labelled else "large image on neighbouring page, no rubric line",
        "source": best["path"],
        "area": area,
        "bytes": best["bytes"],
        "page": best_page,
        "rel": dest_rel(row["book"], row["test"], row["module"], best_page),
    }


def apply_rows(rows: list[dict[str, Any]]) -> list[str]:
    ASSETS.mkdir(parents=True, exist_ok=True)
    copied: dict[Path, Path] = {}
    by_exam: dict[Path, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_exam[row["path"]].append(row)
    changed: list[str] = []
    for path, items in by_exam.items():
        exam = json.loads(path.read_text(encoding="utf-8"))
        groups = {
            g.get("id"): g
            for sec in exam.get("sections") or []
            for g in sec.get("questionGroups") or []
        }
        exam_changed = False
        for row in items:
            src: Path = row["source"]
            dest = ROOT / "fixtures" / row["rel"]
            dest.parent.mkdir(parents=True, exist_ok=True)
            if dest not in copied:
                shutil.copy2(src, dest)
                copied[dest] = src
            group = groups.get(row["group"].get("id"))
            if group is None:
                continue
            if group.get("imageAsset") != row["rel"]:
                group["imageAsset"] = row["rel"]
                exam_changed = True
        if exam_changed:
            bak = path.with_suffix(".json.bak")
            if not bak.exists():
                shutil.copy2(path, bak)
            write_json(path, exam)
            changed.append(path.name)
    return changed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--include-medium", action="store_true")
    args = parser.parse_args()

    pagemap = load_page_map()
    mineru: dict[int, dict[int, dict[str, Any]]] = {}
    for book in BOOKS:
        try:
            mineru[book] = load_mineru_pages(book)
        except FileNotFoundError:
            mineru[book] = {}

    rows = [classify(row, mineru) for row in iter_labelling_gaps(pagemap)]
    counts = defaultdict(int)
    for row in rows:
        counts[row["confidence"]] += 1

    serialisable = []
    for row in rows:
        item = {
            "examId": row["examId"],
            "groupId": row["group"].get("id"),
            "numbers": row["numbers"],
            "pages": row["pages"],
            "confidence": row["confidence"],
            "reason": row["reason"],
            "instruction": row["instruction"],
        }
        if row.get("rel"):
            item["rel"] = row["rel"]
            item["page"] = row["page"]
            item["area"] = row["area"]
            item["bytes"] = row["bytes"]
            item["source"] = str(row["source"])
        serialisable.append(item)
    write_json(REPORT, {
        "schemaVersion": 1,
        "counts": dict(counts),
        "groups": serialisable,
    })

    print(f"labelling groups missing an image: {len(rows)}")
    print(f"  HIGH   {counts['HIGH']}")
    print(f"  MEDIUM {counts['MEDIUM']}")
    print(f"  SKIP   {counts['SKIP']}")
    print(f"report → {REPORT.relative_to(ROOT)}")

    wanted = {"HIGH"} | ({"MEDIUM"} if args.include_medium else set())
    to_write = [r for r in rows if r["confidence"] in wanted]
    if not args.apply:
        print(f"{len(to_write)} groups would receive an image"
              f"{' (HIGH+MEDIUM)' if args.include_medium else ' (HIGH only)'}")
        return 0

    changed = apply_rows(to_write)
    print(f"wrote imageAsset on {len(to_write)} groups in {len(changed)} exams")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
