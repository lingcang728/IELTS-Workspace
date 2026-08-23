# -*- coding: utf-8 -*-
"""Extract native-text Cambridge PDFs with pdftotext -layout."""
from pathlib import Path
import subprocess
import shutil

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data-dev" / "cambridge-extract"
OUT.mkdir(parents=True, exist_ok=True)
BOOKS = Path.home() / "Desktop" / "教材"
PDFTOTEXT = shutil.which("pdftotext") or r"C:\Users\15pro\scoop\shims\pdftotext.exe"
# native-text books from probe
NAMES = ["剑桥雅思真题4.pdf", "剑桥雅思真题9.pdf", "剑桥雅思真题14.pdf"]


def main():
    for name in NAMES:
        pdf = BOOKS / name
        dest = OUT / (pdf.stem + ".txt")
        cmd = [PDFTOTEXT, "-layout", "-enc", "UTF-8", str(pdf), str(dest)]
        print("RUN", pdf.name)
        subprocess.check_call(cmd)
        text = dest.read_text(encoding="utf-8", errors="replace")
        print(f"  -> {dest.name} chars={len(text)} lines={text.count(chr(10))}")


if __name__ == "__main__":
    main()
