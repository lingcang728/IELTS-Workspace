# -*- coding: utf-8 -*-
"""Pack C04-C20 canonical full-track MP3s into immutable per-book ZIPs."""
from __future__ import annotations

import hashlib
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "schema" / "audio-catalog.json"
ASSETS = ROOT / "fixtures" / "assets" / "cambridge"
OUT = ROOT / "output" / "listening-audio-v1"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    by_book: dict[int, list[dict]] = {}
    for entry in catalog["entries"]:
        by_book.setdefault(int(entry["book"]), []).append(entry)
    OUT.mkdir(parents=True, exist_ok=True)
    index = []
    for book in range(4, 21):
        rows = sorted(by_book[book], key=lambda row: row["test"])
        zip_name = f"C{book:02d}-listening.zip"
        zip_path = OUT / zip_name
        files = []
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_STORED, strict_timestamps=False) as zf:
            checksum_lines = []
            for row in rows:
                src = ASSETS / row["standardName"]
                if not src.is_file():
                    raise SystemExit(f"missing canonical track: {src}")
                digest = sha256(src)
                if digest != row["sha256"]:
                    raise SystemExit(f"hash mismatch for {src}: {digest} != {row['sha256']}")
                info = zipfile.ZipInfo(row["standardName"])
                info.date_time = (2001, 1, 1, 0, 0, 0)
                info.compress_type = zipfile.ZIP_STORED
                zf.writestr(info, src.read_bytes())
                checksum_lines.append(f"{digest}  {row['standardName']}")
                files.append(
                    {
                        "name": row["standardName"],
                        "examId": row["examId"],
                        "sha256": digest,
                        "bytes": row["bytes"],
                        "durationMs": row["durationMs"],
                    }
                )
            manifest = {
                "schemaVersion": 1,
                "book": book,
                "releaseTag": "listening-audio-v1",
                "files": files,
            }
            man_info = zipfile.ZipInfo("manifest.json")
            man_info.date_time = (2001, 1, 1, 0, 0, 0)
            man_info.compress_type = zipfile.ZIP_STORED
            zf.writestr(man_info, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
            sum_info = zipfile.ZipInfo("SHA256SUMS.txt")
            sum_info.date_time = (2001, 1, 1, 0, 0, 0)
            sum_info.compress_type = zipfile.ZIP_STORED
            zf.writestr(sum_info, "\n".join(checksum_lines) + "\n")
        zip_digest = sha256(zip_path)
        index.append(
            {
                "book": book,
                "file": zip_name,
                "bytes": zip_path.stat().st_size,
                "sha256": zip_digest,
                "tracks": [row["standardName"] for row in rows],
            }
        )
        print(f"wrote {zip_path} ({zip_path.stat().st_size} bytes)")
    (OUT / "index.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "releaseTag": "listening-audio-v1",
                "books": index,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"index {OUT / 'index.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
