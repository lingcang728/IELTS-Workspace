#!/usr/bin/env python3
"""Extract per-test listening MP3s from the listening-audio-v1 release zips.

Each C{NN}-listening.zip contains c{NN}-t{1..4}.mp3 plus a SHA256SUMS.txt.
Files land in fixtures/assets/cambridge/ so scripts/build-site-content.mjs
bundles them into site/public/content/. Local dev only — CI does the same
extraction inline in .github/workflows/pages.yml.
"""
import hashlib
import io
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ZIP_DIR = ROOT / "data-dev" / "site-audio"
OUT_DIR = ROOT / "fixtures" / "assets" / "cambridge"


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    copied = 0
    for book in range(4, 21):
        zp = ZIP_DIR / f"C{book:02d}-listening.zip"
        if not zp.exists():
            print(f"SKIP {zp.name} (not downloaded)")
            continue
        with zipfile.ZipFile(zp) as z:
            sums = {}
            if "SHA256SUMS.txt" in z.namelist():
                for line in z.read("SHA256SUMS.txt").decode().splitlines():
                    parts = line.split()
                    if len(parts) == 2:
                        sums[parts[1].lstrip("*")] = parts[0]
            for name in z.namelist():
                if not name.lower().endswith(".mp3"):
                    continue
                data = z.read(name)
                want = sums.get(name)
                if want:
                    got = hashlib.sha256(data).hexdigest()
                    if got != want:
                        print(f"HASH-FAIL {name} in {zp.name}")
                        continue
                (OUT_DIR / name).write_bytes(data)
                copied += 1
    print(f"extracted {copied} mp3 -> {OUT_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
