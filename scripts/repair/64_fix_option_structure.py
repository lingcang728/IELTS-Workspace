# -*- coding: utf-8 -*-
"""Stage 6b — repair the declared option structure of multiple-choice groups.

The importer stamped a uniform ``A``-``H`` option set onto every group that
looked like a choice question. Cambridge does not print choices that way: a
listening three-option question prints ``A``/``B``/``C`` and nothing else, a
List of Headings prints ``i``-``viii``, a matching-information question prints
the passage's own paragraph letters. So most groups ended up declaring five
option slots that the printed page never had, each with empty text.

That single defect produced the great majority of the round-3 proofreading
flags: the reviewer is told the group has options ``A``-``H``, finds three on
the page, and correctly refuses to invent ``D``-``H``. No amount of further
page reading fixes it, because the pages are right and the fixture is wrong.

Two repairs, both derived from data already inside the fixture — nothing here
reads a PDF and nothing here invents text:

1. **Trim the declared labels to the rubric.** ``60_recover_rubrics`` already
   replaced each group's instruction with the canonical printed wording. When
   that wording says "Choose the correct letter, A, B or C", the option set is
   ``A``-``C``. The trim is refused if any answer key in the group uses a
   letter outside the range, because then the rubric and the key disagree and
   a human has to look.

2. **Lift inline option text out of the stem.** The parser frequently swept
   the printed choices into the question prompt:
   ``"How much time...? A two hours per week B one day per month C 8 hours"``.
   The three texts are right there, in label order. Move them into the option
   slots and cut the prompt back to the stem. Refused unless all three markers
   appear in order, each with non-empty text, and the group's options are
   still empty — a slot a human already filled is never overwritten.

    python scripts/repair/64_fix_option_structure.py --dry-run
    python scripts/repair/64_fix_option_structure.py
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "fixtures" / "cambridge"

# "Choose the correct letter, A, B or C." — the three-option listening/reading
# stem. Written loosely because OCR eats the odd comma.
ABC_RE = re.compile(r"\bA\s*,?\s*B\s*,?\s*(?:or|and)\s*C\b", re.I)
# "Choose ... A-H", "Write the correct letter, A-J" and friends.
RANGE_RE = re.compile(r"\bA\s*[-–—]\s*([D-K])\b", re.I)

# The printed choices swept into the stem, in label order.
INLINE_ABC_RE = re.compile(
    r"(?:^|\s)A\s+(?P<a>\S.*?)\s+B\s+(?P<b>\S.*?)\s+C\s+(?P<c>\S.+?)\s*$",
    re.S,
)


def letters_used(group: dict) -> set[str]:
    """Every single-letter answer the group's key relies on."""
    used: set[str] = set()
    for question in group.get("questions") or []:
        for answer in question.get("acceptedAnswers") or []:
            text = str(answer).strip()
            if len(text) == 1 and text.isalpha():
                used.add(text.upper())
    return used


def declared_labels(group: dict) -> list[str] | None:
    """The label set the group's own rubric claims, or None when unreadable."""
    instruction = group.get("instruction") or ""
    if ABC_RE.search(instruction):
        return ["A", "B", "C"]
    match = RANGE_RE.search(instruction)
    if match:
        last = match.group(1).upper()
        return [chr(code) for code in range(ord("A"), ord(last) + 1)]
    return None


def option_slots(group: dict) -> list[dict]:
    return group.get("sharedOptions") or []


def trim_options(options: list[dict], keep: list[str]) -> list[dict] | None:
    """Drop the slots the rubric does not declare — but only empty ones.

    The guard exists because the first version of this script deleted nine
    real List-of-Headings options. That group's instruction reads "Reading
    Passage 1 has seven paragraphs, A-G", and `A-G` there numbers the
    *paragraphs*, not the choices, which are `i`-`ix`. Reading it as an option
    range trimmed every option away, text and all.

    So two invariants, and the ratchet is not the place to discover a breach:
    an option carrying text is never deleted, and a label outside the
    declared alphabet (roman numerals against a letter range) is never even
    considered. Returns None when the trim would not be an improvement.
    """
    wanted = set(keep)
    kept: list[dict] = []
    dropped = 0
    for option in options:
        label = str(option.get("label", "")).strip()
        text = (option.get("text") or "").strip()
        same_alphabet = len(label) == 1 and label.upper().isalpha()
        if label.upper() in wanted or text or not same_alphabet:
            kept.append(option)
            continue
        dropped += 1
    if not dropped or len(kept) < 2:
        return None
    return kept


def all_empty(options: list[dict]) -> bool:
    return bool(options) and all(not (o.get("text") or "").strip() for o in options)


def fix_group(group: dict, stats: dict[str, int]) -> bool:
    labels = declared_labels(group)
    if not labels:
        return False
    changed = False

    used = letters_used(group)
    outside = {letter for letter in used if letter not in set(labels)}

    # 1. Trim the declared set to what the rubric says.
    if outside:
        stats["refused_key_outside_rubric"] += 1
        return False
    for holder in [group] + list(group.get("questions") or []):
        key = "sharedOptions" if holder is group else "options"
        options = holder.get(key) or []
        trimmed = trim_options(options, labels) if options else None
        if trimmed is not None:
            holder[key] = trimmed
            changed = True
            stats["trimmed"] += 1

    # 2. Lift inline choices out of the stem, three-option groups only.
    if labels == ["A", "B", "C"]:
        for question in group.get("questions") or []:
            options = question.get("options") or []
            if not all_empty(options) or len(options) != 3:
                continue
            prompt = question.get("prompt") or ""
            match = INLINE_ABC_RE.search(prompt)
            if not match:
                continue
            stem = prompt[: match.start()].strip()
            texts = [match.group("a").strip(), match.group("b").strip(), match.group("c").strip()]
            if not stem or any(not t for t in texts):
                continue
            # A stem that lost everything but a label run is not a stem.
            if len(stem) < 8:
                continue
            for option, text in zip(options, texts):
                option["text"] = text
            shared = option_slots(group)
            if all_empty(shared) and len(shared) == 3 and len(group.get("questions") or []) == 1:
                for option, text in zip(shared, texts):
                    option["text"] = text
            question["prompt"] = stem
            changed = True
            stats["inline_recovered"] += 1
    return changed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="report without writing")
    parser.add_argument("--no-backup", action="store_true", help="do not leave a .bak")
    args = parser.parse_args()

    stats = {"trimmed": 0, "inline_recovered": 0, "refused_key_outside_rubric": 0}
    files_changed = 0

    for path in sorted(FIXTURES.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        touched = False
        for section in data.get("sections") or []:
            for group in section.get("questionGroups") or []:
                if fix_group(group, stats):
                    touched = True
        if not touched:
            continue
        files_changed += 1
        if args.dry_run:
            continue
        if not args.no_backup:
            shutil.copy2(path, path.with_suffix(".json.bak"))
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    verb = "would change" if args.dry_run else "changed"
    print(f"{files_changed} exam files {verb}")
    print(f"  option sets trimmed to the rubric : {stats['trimmed']}")
    print(f"  inline A/B/C text recovered       : {stats['inline_recovered']}")
    print(f"  refused, key uses a letter the rubric does not declare: "
          f"{stats['refused_key_outside_rubric']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
