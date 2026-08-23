# -*- coding: utf-8 -*-
"""OCR Cambridge IELTS PDFs to JSONL boxes. Resume-safe."""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("ORT_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")

import ctypes
import gc

import fitz
import numpy as np
from rapidocr_onnxruntime import RapidOCR

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data-dev" / "cambridge-ocr"
BOOKS = Path.home() / "Desktop" / "教材"
DPI = 110
SLEEP_PAGE = 0.45
SLEEP_EVERY = 8
SLEEP_BLOCK = 2.0

try:
    ctypes.windll.kernel32.SetPriorityClass(
        ctypes.windll.kernel32.GetCurrentProcess(), 0x00004000
    )
except Exception:
    pass

# Prefer these files (skip the duplicate C20 抢先版 unless flagged)
SKIP = {"剑桥雅思真题20-抢先版拼合.pdf"}


def boxes_from_result(result) -> list[dict]:
    items = []
    if not result:
        return items
    for box, text, score in result:
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        items.append(
            {
                "text": str(text).strip(),
                "score": float(score or 0),
                "x": float(min(xs)),
                "y": float(sum(ys) / len(ys)),
                "x1": float(max(xs)),
                "y1": float(max(ys)),
            }
        )
    items.sort(key=lambda t: (round(t["y"] / 16), t["x"]))
    return items


def ocr_pdf(pdf: Path, ocr: RapidOCR, only_pages: list[int] | None = None) -> Path:
    dest_dir = OUT / pdf.stem
    dest_dir.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(pdf)
    total = doc.page_count
    pages = only_pages or list(range(total))
    done = 0
    t0 = time.time()
    for i in pages:
        outp = dest_dir / f"p{i+1:04d}.json"
        if outp.exists() and outp.stat().st_size > 10:
            head = outp.read_bytes()[:4]
            if head != b"\x00\x00\x00\x00":
                done += 1
                continue
        page = doc[i]
        pix = page.get_pixmap(matrix=fitz.Matrix(DPI / 72, DPI / 72), alpha=False)
        img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.h, pix.w, pix.n).copy()
        pix = None
        result, _ = ocr(img)
        del img
        items = boxes_from_result(result)
        outp.write_text(json.dumps({"page": i + 1, "w": int(page.rect.width * DPI / 72), "h": int(page.rect.height * DPI / 72), "items": items}, ensure_ascii=False), encoding="utf-8")
        done += 1
        if done % 5 == 0 or i == pages[-1]:
            elapsed = time.time() - t0
            print(f"  {pdf.stem} {done}/{len(pages)} ({elapsed/max(done,1):.1f}s/p)", flush=True)
        time.sleep(SLEEP_PAGE)
        if done % SLEEP_EVERY == 0:
            gc.collect()
            time.sleep(SLEEP_BLOCK)
    doc.close()
    return dest_dir


def main():
    only = None
    names = []
    args = sys.argv[1:]
    tail = None
    if args and args[0] == "--tail":
        tail = int(args[1])
        names = args[2:]
    elif args and args[0] == "--pages":
        only = [int(x) - 1 for x in args[1].split(",")]
        names = args[2:]
    else:
        names = args
    pdfs = []
    if names:
        for n in names:
            p = Path(n)
            if not p.is_absolute():
                p = BOOKS / n
            pdfs.append(p)
    else:
        pdfs = [p for p in sorted(BOOKS.glob("*.pdf")) if p.name not in SKIP]
    print("OCR books:", [p.name for p in pdfs], "only", only, "tail", tail)
    ocr = RapidOCR()
    for pdf in pdfs:
        print("==", pdf.name, flush=True)
        pages = only
        if tail and only is None:
            doc = fitz.open(pdf)
            n = doc.page_count
            doc.close()
            start = max(0, n - tail)
            pages = list(range(start, n))
            print(f"  tail pages {start+1}-{n}", flush=True)
        ocr_pdf(pdf, ocr, only_pages=pages)
        gc.collect()
        time.sleep(3)


if __name__ == "__main__":
    main()
