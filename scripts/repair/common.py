# -*- coding: utf-8 -*-
"""Shared helpers for the Cambridge corpus repair pipeline.

The pipeline is deliberately split into idempotent stages that each write a
JSON artefact under ``data-dev/repair/``. Nothing here mutates
``fixtures/cambridge/`` -- only ``40_apply.py`` does, and it always merges
``fixtures/overlays/`` on top (see AGENTS.md section 4).
"""
from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path
from typing import Any, Iterator

ROOT = Path(__file__).resolve().parents[2]
MINERU_ROOT = ROOT / "data-dev" / "mineru"
FIXTURES = ROOT / "fixtures" / "cambridge"
OVERLAYS = ROOT / "fixtures" / "overlays"
TRANSCRIPTS = ROOT / "fixtures" / "transcripts"
REPAIR = ROOT / "data-dev" / "repair"

BOOKS = tuple(range(4, 22))
AUDIO_BOOKS = tuple(range(4, 21))
TESTS = (1, 2, 3, 4)
MODULES = ("listening", "reading")

# MinerU emits en/em dashes and a stray "一" for hyphens in scanned ranges.
DASHES = "-‐‑‒–—―−－一"
DASH_CLASS = "[" + re.escape(DASHES) + "]"

QUESTIONS_RANGE_RE = re.compile(
    r"Questions?\s*(\d{1,2})\s*(?:" + DASH_CLASS + r"|and|&|to)\s*(\d{1,2})",
    re.I,
)
# Listening sections were renamed "Parts" from Cambridge 16 onwards, so both
# spellings have to be accepted or the newer books all look like reading papers.
SECTION_RE = re.compile(r"^#*\s*(?:SECTION|PART)\s*([1-4])\b", re.I | re.M)
PASSAGE_RE = re.compile(r"^#*\s*READING\s+PASSAGE\s*(\d)\b", re.I | re.M)
# Cambridge changed the appendix title three times: Transcript (C4),
# Tapescripts (C5-C9), Audioscripts (C10-C20). Accept all of them.
# C4 prints it as a bare line, C5-C9 as "Tapescripts 128" with the page number
# still attached, C10-C20 as a proper "## Audioscripts" heading. Match a short
# standalone line so an occurrence inside a passage cannot be mistaken for it.
TRANSCRIPT_HEADING_RE = re.compile(
    r"^#{0,3}\s*(?:Audioscripts?|Tapescripts?|Transcripts?)\s*\d{0,4}\s*$", re.I | re.M
)


def mineru_markdown(book: int) -> Path:
    """Locate a book's MinerU markdown.

    C21 was produced with the hybrid pipeline, so its output lives in
    ``hybrid_auto/`` rather than ``auto/``; both are matched.
    """
    base = MINERU_ROOT / f"C{book:02d}"
    hits = sorted(base.glob("*/auto/*.md")) + sorted(base.glob("*/hybrid_auto/*.md"))
    if not hits:
        raise FileNotFoundError(f"no MinerU markdown for book {book} under {base}")
    return max(hits, key=lambda p: p.stat().st_size)


def load_markdown(book: int) -> str:
    return mineru_markdown(book).read_text(encoding="utf-8", errors="replace")


def exam_id(book: int, test: int, module: str) -> str:
    return f"cambridge-{book}-test-{test}-{module}"


def exam_path(book: int, test: int, module: str) -> Path:
    return FIXTURES / f"{exam_id(book, test, module)}.json"


def load_exam(book: int, test: int, module: str) -> dict[str, Any] | None:
    path = exam_path(book, test, module)
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def iter_questions(exam: dict[str, Any]) -> Iterator[tuple[dict, dict, dict]]:
    for section in exam.get("sections") or []:
        for group in section.get("questionGroups") or []:
            for question in group.get("questions") or []:
                yield section, group, question


def nfc(text: str) -> str:
    return unicodedata.normalize("NFC", text)


def squash(text: str) -> str:
    """Whitespace-insensitive form used for anchor matching."""
    return re.sub(r"\s+", " ", nfc(text)).strip()


def alnum_key(text: str) -> str:
    """Letters and digits only, lowercased.

    OCR mangles punctuation and spacing far more often than letters, so anchor
    comparisons run on this reduction rather than on the raw text.
    """
    return re.sub(r"[^0-9a-z]+", "", nfc(text).lower())


def strip_tables(text: str) -> str:
    return re.sub(r"<table>.*?</table>", " ", text, flags=re.S | re.I)


def table_blocks(text: str) -> list[str]:
    return re.findall(r"<table>.*?</table>", text, flags=re.S | re.I)


def write_json(path: Path, payload: Any) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))
