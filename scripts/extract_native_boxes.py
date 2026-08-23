# -*- coding: utf-8 -*-
"""Dump PDF native text boxes in the same JSON shape as ocr_cambridge.py.

No raster, no RapidOCR. Resume-safe. One page at a time.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import fitz

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data-dev" / "cambridge-ocr"
BOOKS = Path.home() / "Desktop" / "教材"
SKIP = {"剑桥雅思真题20-抢先版拼合.pdf"}
REPORT = ROOT / "data-dev" / "cambridge-native-probe.json"


def spans_to_items(page: fitz.Page) -> list[dict]:
    items = []
    data = page.get_text("dict")
    for block in data.get("blocks", []):
        for line in block.get("lines", []) if "lines" in block else []:
            for span in line.get("spans", []):
                t = (span.get("text") or "").strip()
                if not t:
                    continue
                x0, y0, x1, y1 = span["bbox"]
                items.append(
                    {
                        "text": t,
                        "score": 1.0,
                        "x": float(x0),
                        "y": float((y0 + y1) / 2),
                        "x1": float(x1),
                        "y1": float(y1),
                    }
                )
    items.sort(key=lambda t: (round(t["y"] / 16), t["x"]))
    return items


def probe_and_extract() -> list[dict]:
    OUT.mkdir(parents=True, exist_ok=True)
    pdfs = [p for p in sorted(BOOKS.glob("*.pdf")) if p.name not in SKIP]
    report = []
    for pdf in pdfs:
        print("==", pdf.name, flush=True)
        doc = fitz.open(pdf)
        n = doc.page_count
        sample_idx = list(range(min(4, n))) + list(range(max(0, n - 8), n))
        sample_chars = 0
        for i in sample_idx:
            sample_chars += len(doc[i].get_text() or "")
        avg = sample_chars / max(len(sample_idx), 1)
        dest = OUT / pdf.stem
        dest.mkdir(parents=True, exist_ok=True)
        written = 0
        skipped_empty = 0
        kept_ocr = 0
        if avg < 80:
            # likely scan; leave existing OCR, do not raster
            existing = len(list(dest.glob("p*.json")))
            rec = {
                "file": pdf.name,
                "pages": n,
                "sample_avg_chars": round(avg, 1),
                "kind": "scan_or_image",
                "existing_json": existing,
                "written": 0,
            }
            print("  SKIP raster/OCR", rec, flush=True)
            report.append(rec)
            doc.close()
            continue
        for i in range(n):
            outp = dest / f"p{i+1:04d}.json"
            items = spans_to_items(doc[i])
            chars = sum(len(it["text"]) for it in items)
            if chars < 12:
                skipped_empty += 1
                continue
            if outp.exists() and outp.stat().st_size > 20:
                try:
                    old = json.loads(outp.read_text(encoding="utf-8"))
                except Exception:
                    old = {}
                if old.get("source") != "native" and len(old.get("items") or []) >= len(items):
                    kept_ocr += 1
                    continue
            payload = {
                "page": i + 1,
                "w": int(page_width(doc[i])),
                "h": int(page_height(doc[i])),
                "items": items,
                "source": "native",
            }
            outp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            written += 1
        rec = {
            "file": pdf.name,
            "pages": n,
            "sample_avg_chars": round(avg, 1),
            "kind": "native_text",
            "written": written,
            "skipped_empty": skipped_empty,
            "kept_ocr": kept_ocr,
        }
        print(" ", rec, flush=True)
        report.append(rec)
        doc.close()
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def page_width(page: fitz.Page) -> float:
    return float(page.rect.width)


def page_height(page: fitz.Page) -> float:
    return float(page.rect.height)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    probe_and_extract()
