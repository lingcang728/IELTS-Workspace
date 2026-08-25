# -*- coding: utf-8 -*-
"""Build schema/audio-catalog.json from the local audio manifest and part offsets."""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "data-dev" / "cambridge-audio-manifest.json"
OFFSETS = ROOT / "data-dev" / "repair" / "part-offsets.json"
OUT = ROOT / "schema" / "audio-catalog.json"


def main() -> int:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    offsets = json.loads(OFFSETS.read_text(encoding="utf-8"))
    offset_by_id = {row["examId"]: row for row in offsets["results"]}
    entries = []
    for item in manifest["entries"]:
        book = int(item["book"])
        test = int(item["test"])
        exam_id = f"cambridge-{book}-test-{test}-listening"
        off = offset_by_id.get(exam_id)
        if not off or not off.get("ok"):
            raise SystemExit(f"missing part offsets for {exam_id}")
        duration_ms = int(round(float(item["durationSeconds"]) * 1000))
        entries.append(
            {
                "examId": exam_id,
                "book": book,
                "test": test,
                "standardName": f"c{book:02d}-t{test}.mp3",
                "sha256": item["sha256"],
                "bytes": int(item["bytes"]),
                "durationMs": duration_ms,
                "partStartsMs": [int(x) for x in off["partOffsetsMs"]],
                "partDurationsMs": [int(x) for x in off["partDurationsMs"]],
            }
        )
    entries.sort(key=lambda row: (row["book"], row["test"]))
    if len(entries) != 68:
        raise SystemExit(f"expected 68 catalog entries, got {len(entries)}")
    payload = {
        "schemaVersion": 1,
        "contentVersion": "1.3.0",
        "releaseTag": "listening-audio-v1",
        "guideUrl": "https://ielts-workspace.pages.dev/#listening",
        "expected": 68,
        "entries": entries,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT} ({len(entries)} entries)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
