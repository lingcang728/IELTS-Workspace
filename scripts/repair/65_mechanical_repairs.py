# -*- coding: utf-8 -*-
"""Stage 6c — the repairs that need no page, and only those.

Three narrow passes over damage the gate reports. Each one is refused unless
the fixture already contains enough information to be certain; everything else
is left for the page-reading round, where a human or a reviewing model looks at
the printed book. Measured before writing, so the scope is honest:

  * table cell fragments — 64 prompts still carry a ``|``. Only the 22 with a
    pipe at the very start or end are safe: the pipe is a leftover edge and the
    text beside it is the whole stem. The other 42 merged two or more cells,
    and only 2 of those have exactly one cell containing a blank marker, so
    there is no reliable rule for which cell is the question. Refused.

  * questions typed ``completion`` whose key is a bare option letter — 90 of
    them. 18 already carry real options and 7 more can take the group's, so
    those are retyped. The remaining 65 have no options anywhere; retyping
    them would only move the damage from "wrong type" to "no options", so they
    are left alone.

  * choices swept into the stem — stage 6b took the ones whose rubric declared
    three options. 4 more are recoverable where the prompt itself carries the
    ``A ... B ... C`` run even though the rubric never said so.

Word de-gluing ("theMary Rose") is deliberately NOT here. Only 16 prompts are
affected, and a blind case-transition split breaks real names (McKinley,
MacGregor, iPhone). 16 is small enough to read, so they are fixed by an
explicit reviewed table below rather than by a regex that would be wrong
somewhere it was never checked.

    python scripts/repair/65_mechanical_repairs.py --dry-run
    python scripts/repair/65_mechanical_repairs.py
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "fixtures" / "cambridge"

INLINE_ABC_RE = re.compile(
    r"(?:^|\s)A\s+(?P<a>\S.*?)\s+B\s+(?P<b>\S.*?)\s+C\s+(?P<c>\S.+?)\s*$", re.S
)

# Reviewed one by one against the surrounding prompt. Only pairs where the two
# halves are unambiguously separate words; nothing that could be a real name.
DEGLUE = [
    ("theMary Rose", "the Mary Rose"),
    ("the MaryRose", "the Mary Rose"),
    ("theUrubamba", "the Urubamba"),
    ("NewYork", "New York"),
    ("theIcela", "the Icela"),
    ("builtOniton", "built Oniton"),
    ("carvedmonument", "carved monument"),
    ("areacommissioned", "area commissioned"),
    ("QueenNathavatji", "Queen Nathavatji"),
    ("ice-formingareas", "ice-forming areas"),
    ("bilingualpeople", "bilingual people"),
    ("ageometrical", "a geometrical"),
    ("patternCarved", "pattern Carved"),
    ("ofameni", "of ameni"),
]


# "Write ONE WORD ONLY", "NO MORE THAN TWO WORDS" — the answer is written, not
# chosen, so the group has no options at all.
WRITTEN_ANSWER_RE = re.compile(
    r"\bONE WORD ONLY\b|\bNO MORE THAN (?:ONE|TWO|THREE) WORDS?\b", re.I
)

JUDGEMENT_WORDS = {"TRUE", "FALSE", "NOT GIVEN", "YES", "NO"}
# "views of the writer" / "claims of the writer" is the YES/NO/NOT GIVEN rubric;
# "information given" is the TRUE/FALSE/NOT GIVEN one. Cambridge is consistent
# about this, which is what makes a bare "Y" safe to expand.
YES_NO_RUBRIC_RE = re.compile(r"\b(?:views|claims)\s+of\s+the\s+writer\b", re.I)


def texted(options: list[dict]) -> int:
    return sum(1 for o in options if (o.get("text") or "").strip())


def drop_phantom_options(group: dict, stats: dict[str, int]) -> bool:
    """Remove the option slots a written-answer group should never have had.

    58 groups whose rubric asks the test-taker to *write* a word still carry a
    row of empty `A`-`H` slots from the importer, so the app offers a choice
    where the printed page offers a blank line. 22 of them answer with a bare
    letter, which means either a real word bank or a corrupt key — either way a
    human has to look, so they are left alone. The other 36 answer with words
    ("solar"), and for those the slots are simply phantom.
    """
    instruction = group.get("instruction") or ""
    if not WRITTEN_ANSWER_RE.search(instruction):
        return False
    shared = group.get("sharedOptions") or []
    if not shared or texted(shared):
        return False
    answers = [str(a).strip() for q in (group.get("questions") or [])
               for a in (q.get("acceptedAnswers") or [])]
    if not answers or any(len(a) == 1 and a.isalpha() for a in answers):
        return False
    group["sharedOptions"] = []
    for question in group.get("questions") or []:
        if question.get("options") and not texted(question["options"]):
            question["options"] = []
        question["type"] = "completion"
    stats["phantom_options_dropped"] += 1
    return True


def strip_edge_pipes(prompt: str) -> str | None:
    """Drop a leading/trailing table edge. Refuses anything with an inner pipe."""
    core = prompt.strip()
    if "|" not in core:
        return None
    if "|" in core.strip("|").strip():
        return None
    cleaned = core.strip("|").strip()
    return cleaned if cleaned and cleaned != prompt else None


def repair_question(question: dict, group: dict, stats: dict[str, int]) -> bool:
    changed = False
    prompt = question.get("prompt") or ""

    cleaned = strip_edge_pipes(prompt)
    if cleaned:
        question["prompt"] = prompt = cleaned
        stats["pipe_edges_stripped"] += 1
        changed = True

    for glued, spaced in DEGLUE:
        if glued in prompt:
            prompt = prompt.replace(glued, spaced)
            question["prompt"] = prompt
            stats["deglued"] += 1
            changed = True

    answers = [str(a).strip() for a in (question.get("acceptedAnswers") or [])]
    lettery = bool(answers) and all(len(a) == 1 and a.isalpha() for a in answers)
    options = question.get("options") or []
    shared = group.get("sharedOptions") or []

    # The printed key settles the type when it is a judgement word. TRUE/FALSE
    # and YES/NO are different question types in IELTS and the app renders them
    # differently, so the pair present in the key decides which; a group whose
    # key is only "NOT GIVEN" keeps whichever judgement type it already had.
    # "Y" and "N" are the printed YES/NO abbreviated by the extraction, not
    # option labels. IELTS splits these two rubrics on a fixed rule: statements
    # measured against the writer's *views* or *claims* are answered YES / NO /
    # NOT GIVEN, while statements measured against the *information* are TRUE /
    # FALSE / NOT GIVEN. So the rubric alone settles the expansion, and it adds
    # nothing the page did not already say — without it the scorer marks a
    # correct "YES" wrong. Groups whose key happens to hold a "N" for another
    # reason (a word bank running to Q) do not match and are left alone.
    if answers and all(a.upper() in {"Y", "N"} for a in answers) and \
            YES_NO_RUBRIC_RE.search(group.get("instruction") or ""):
        answers = ["YES" if a.upper() == "Y" else "NO" for a in answers]
        question["acceptedAnswers"] = answers
        stats["yn_expanded"] += 1
        changed = True

    upper = {a.upper() for a in answers}
    if upper and upper <= JUDGEMENT_WORDS:
        if upper & {"TRUE", "FALSE"}:
            wanted = "true_false_ng"
        elif upper & {"YES", "NO"}:
            wanted = "yes_no_ng"
        else:
            wanted = question.get("type") if question.get("type") in (
                "true_false_ng", "yes_no_ng") else "true_false_ng"
        if question.get("type") != wanted:
            question["type"] = wanted
            # A judgement question has no options; leaving a row of empty slots
            # behind would put buttons under a TRUE/FALSE/NOT GIVEN prompt.
            if options and not texted(options):
                question["options"] = []
            stats["retyped_from_judgement_key"] += 1
            changed = True

    if lettery and question.get("type") in ("completion", "true_false_ng", "yes_no_ng"):
        if texted(options) >= 2:
            question["type"] = "matching"
            stats["retyped_own_options"] += 1
            changed = True
        elif not options and texted(shared) >= 2:
            question["options"] = [dict(o) for o in shared]
            question["type"] = "matching"
            stats["retyped_inherited_options"] += 1
            changed = True

    # Choices left in the stem that stage 6b's rubric test did not reach.
    options = question.get("options") or []
    if lettery and len(options) == 3 and texted(options) == 0:
        match = INLINE_ABC_RE.search(prompt)
        if match:
            stem = prompt[: match.start()].strip()
            texts = [match.group(k).strip() for k in ("a", "b", "c")]
            if len(stem) >= 8 and all(texts):
                for option, text in zip(options, texts):
                    option["text"] = text
                question["prompt"] = stem
                stats["inline_recovered"] += 1
                changed = True
    return changed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    stats = {
        "pipe_edges_stripped": 0,
        "deglued": 0,
        "retyped_own_options": 0,
        "retyped_inherited_options": 0,
        "inline_recovered": 0,
        "phantom_options_dropped": 0,
        "retyped_from_judgement_key": 0,
        "yn_expanded": 0,
    }
    files = 0
    for path in sorted(FIXTURES.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        touched = False
        for section in data.get("sections") or []:
            for group in section.get("questionGroups") or []:
                for question in group.get("questions") or []:
                    if repair_question(question, group, stats):
                        touched = True
                if drop_phantom_options(group, stats):
                    touched = True
        if not touched:
            continue
        files += 1
        if args.dry_run:
            continue
        shutil.copy2(path, path.with_suffix(".json.bak"))
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"{files} exam files {'would change' if args.dry_run else 'changed'}")
    for key, value in stats.items():
        print(f"  {key:28s} {value}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
