# -*- coding: utf-8 -*-
"""Gate for the shipped (non-audio) Cambridge content pack."""
from __future__ import annotations

import json
import sys
from pathlib import Path

if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if sys.stderr and hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
CAMBRIDGE = ROOT / "fixtures" / "cambridge"
ASSETS = ROOT / "fixtures" / "assets" / "cambridge"
TRANSCRIPTS = ROOT / "fixtures" / "transcripts"
CATALOG = ROOT / "schema" / "audio-catalog.json"

EXPECTED_EXAMS = 212
EXPECTED_IMAGES = 86
EXPECTED_TRANSCRIPTS = 64
EXPECTED_AUDIO_ENTRIES = 68
AUDIO_EXT = {".mp3", ".m4a", ".wav"}


def fail(message: str) -> int:
    print(f"content-pack: {message}", file=sys.stderr)
    return 1


def main() -> int:
    exams = sorted(p for p in CAMBRIDGE.glob("*.json") if p.suffix == ".json")
    images = sorted(ASSETS.glob("*.jpg"))
    transcripts = sorted(TRANSCRIPTS.glob("*.json"))
    audio_in_assets = [p for p in ASSETS.iterdir() if p.is_file() and p.suffix.lower() in AUDIO_EXT]
    if len(exams) != EXPECTED_EXAMS:
        return fail(f"expected {EXPECTED_EXAMS} exam JSON, got {len(exams)}")
    if len(images) != EXPECTED_IMAGES:
        return fail(f"expected {EXPECTED_IMAGES} jpg images, got {len(images)}")
    if len(transcripts) != EXPECTED_TRANSCRIPTS:
        return fail(f"expected {EXPECTED_TRANSCRIPTS} transcripts, got {len(transcripts)}")
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    entries = catalog.get("entries") or []
    if len(entries) != EXPECTED_AUDIO_ENTRIES:
        return fail(f"audio catalog expected {EXPECTED_AUDIO_ENTRIES}, got {len(entries)}")
    seen = set()
    for entry in entries:
        exam_id = entry.get("examId")
        sha = entry.get("sha256")
        parts = entry.get("partStartsMs") or []
        if not exam_id or exam_id in seen:
            return fail(f"bad catalog examId: {exam_id!r}")
        if not isinstance(sha, str) or len(sha) != 64:
            return fail(f"{exam_id}: sha256 missing")
        if len(parts) != 4:
            return fail(f"{exam_id}: need 4 partStartsMs")
        seen.add(exam_id)
        exam_path = CAMBRIDGE / f"{exam_id}.json"
        if not exam_path.is_file():
            return fail(f"catalog exam missing JSON: {exam_id}")
    # The pack that gets embedded must never grow an audio file.
    pack_audio = [p for p in images if p.suffix.lower() in AUDIO_EXT]
    if pack_audio:
        return fail(f"image glob matched audio: {pack_audio[:3]}")
    print(
        "content-pack: "
        f"{len(exams)} exams, {len(images)} images, {len(transcripts)} transcripts, "
        f"{len(entries)} catalog entries"
        + (f"; local mp3 present={len(audio_in_assets)}" if audio_in_assets else "; audio files not required")
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
