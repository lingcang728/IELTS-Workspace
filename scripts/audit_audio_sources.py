from __future__ import annotations

import hashlib
import json
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from concat_listening_audio import find_parts


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "data-dev" / "cambridge-audio-manifest.json"
REPORT = ROOT / "data-dev" / "audio-source-audit.json"
FFPROBE = "ffprobe"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def duration(path: Path) -> float:
    result = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
        check=True,
        capture_output=True,
        text=True,
    )
    return float(result.stdout.strip())


def main() -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    entries = manifest["entries"]
    source_parts: dict[str, list[Path]] = {}
    all_audio: set[Path] = set()

    for entry in entries:
        book = int(entry["book"])
        test = int(entry["test"])
        source_test = test + 4 if book == 12 else test
        parts = find_parts(book, source_test)
        source_parts[entry["file"]] = parts
        all_audio.update(parts)
        app_file = ROOT / entry["file"]
        if app_file.exists():
            all_audio.add(app_file)

    with ThreadPoolExecutor(max_workers=8) as pool:
        measured = dict(zip(all_audio, pool.map(duration, all_audio)))

    results = []
    for entry in entries:
        app_file = ROOT / entry["file"]
        parts = source_parts[entry["file"]]
        source_duration = sum(measured[path] for path in parts)
        app_duration = measured.get(app_file)
        duration_delta = None if app_duration is None or not parts else round(app_duration - source_duration, 6)
        results.append({
            "book": entry["book"],
            "test": entry["test"],
            "appFile": entry["file"],
            "appExists": app_file.exists(),
            "manifestSha256Matches": app_file.exists() and sha256(app_file) == entry["sha256"],
            "sourceFiles": [str(path) for path in parts],
            "sourceFileCount": len(parts),
            "sourceDurationSeconds": round(source_duration, 6) if parts else None,
            "appDurationSeconds": round(app_duration, 6) if app_duration is not None else None,
            "durationDeltaSeconds": duration_delta,
            "durationMatchesSource": duration_delta is not None and abs(duration_delta) <= 5.0,
        })

    active_json = list((ROOT / "fixtures").rglob("*.json"))
    active_text = "\n".join(path.read_text(encoding="utf-8", errors="replace") for path in active_json)
    summary = {
        "expected": len(entries),
        "appFilesPresent": sum(item["appExists"] for item in results),
        "manifestHashesMatched": sum(item["manifestSha256Matches"] for item in results),
        "desktopSourcesMatchedByDuration": sum(item["durationMatchesSource"] for item in results),
        "missingDesktopSource": [item["appFile"] for item in results if item["sourceFileCount"] == 0],
        "activeSyntheticListeningReference": "listening-mock-a.wav" in active_text,
    }
    report = {"schemaVersion": 1, "summary": summary, "entries": results}
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
