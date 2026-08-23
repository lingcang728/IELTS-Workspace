# -*- coding: utf-8 -*-
"""Concatenate per-section Cambridge listening audio into one file per test."""
from __future__ import annotations

import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AUDIO_SRC = Path.home() / "Desktop" / "听力"
OUT = ROOT / "fixtures" / "assets" / "cambridge"
FFMPEG = r"C:\Users\15pro\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg.Essentials_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.1.1-essentials_build\bin\ffmpeg.exe"

# Book 12 uses Test 5-8; others 1-4. Books 1-3 audio exists without PDF.
BOOK_TESTS = {n: [1, 2, 3, 4] for n in range(1, 22)}
BOOK_TESTS[12] = [5, 6, 7, 8]


def find_parts(book: int, test: int) -> list[Path]:
    d = AUDIO_SRC / f"剑{book}" / f"Test{test}"
    parts: list[Path] = []
    if d.is_dir():
        for i in range(1, 5):
            found = None
            for name in (
                f"Section{i}.mp3",
                f"Part{i}.mp3",
                f"Section{i}.m4a",
                f"Part{i}.m4a",
                f"Section{i}.wav",
                f"Part{i}.wav",
            ):
                p = d / name
                if p.exists() and p.stat().st_size > 10_000:
                    found = p
                    break
            if not found:
                parts = []
                break
            parts.append(found)
        if len(parts) == 4:
            return parts
    # whole-test fallback
    parent = AUDIO_SRC / f"剑{book}"
    for ext in (".mp3", ".wav", ".m4a"):
        p = parent / f"Test{test}{ext}"
        if p.exists() and p.stat().st_size > 10_000:
            return [p]
    return []


def concat(parts: list[Path], dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 50_000:
        return
    if len(parts) == 1:
        # remux to mp3 if needed
        cmd = [FFMPEG, "-y", "-i", str(parts[0]), "-c:a", "libmp3lame", "-q:a", "4", str(dest)]
        subprocess.check_call(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return
    lst = dest.with_suffix(".txt")
    # concat demuxer needs same codec; use filter instead for mixed mp3/m4a
    inputs = []
    for p in parts:
        inputs += ["-i", str(p)]
    n = len(parts)
    filt = "".join(f"[{i}:a]" for i in range(n)) + f"concat=n={n}:v=0:a=1[a]"
    cmd = [FFMPEG, "-y", *inputs, "-filter_complex", filt, "-map", "[a]", "-c:a", "libmp3lame", "-q:a", "4", str(dest)]
    subprocess.check_call(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    ok, miss = [], []
    for book, tests in BOOK_TESTS.items():
        for test in tests:
            parts = find_parts(book, test)
            dest = OUT / f"c{book:02d}-t{test}.mp3"
            if not parts:
                miss.append(f"c{book}-t{test}")
                continue
            print(f"concat c{book} t{test} <- {[p.name for p in parts]}", flush=True)
            concat(parts, dest)
            ok.append(dest)
    print(f"OK {len(ok)} missing {miss}")


if __name__ == "__main__":
    main()
