# -*- coding: utf-8 -*-
from pathlib import Path
import fitz

books = Path.home() / "Desktop" / "教材"
out = Path(__file__).resolve().parents[1] / "scripts" / "_probe_cambridge.txt"
lines = []
for pdf in sorted(books.glob("*.pdf"), key=lambda p: p.name):
    doc = fitz.open(pdf)
    n = doc.page_count
    chunks = []
    sample_pages = [0, 1, 2, min(10, n - 1), min(30, n - 1), max(0, n // 2), max(0, n - 5)]
    total_chars = 0
    for i in range(n):
        t = doc[i].get_text("text") or ""
        total_chars += len(t)
    for i in sample_pages:
        t = (doc[i].get_text("text") or "").replace("\n", " | ")
        chunks.append(f"  p{i+1}({len(doc[i].get_text('text') or '')}c): {t[:240]}")
    avg = total_chars / max(n, 1)
    kind = "TEXT" if avg > 400 else ("MIXED" if avg > 80 else "SCAN")
    lines.append(f"{pdf.name} pages={n} avg_chars={avg:.0f} {kind} size={pdf.stat().st_size/1e6:.1f}MB")
    lines.extend(chunks)
    lines.append("")
    doc.close()
out.write_text("\n".join(lines), encoding="utf-8")
print("wrote", out, "lines", len(lines))
