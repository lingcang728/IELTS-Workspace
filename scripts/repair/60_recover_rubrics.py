# -*- coding: utf-8 -*-
"""Stage 9 — recover the group rubric ("Write ONE WORD ONLY", "Choose TWO
letters, A-E") that the importer replaced with a placeholder.

Why this is scriptable when stem repair was not
-----------------------------------------------
A question stem is free text: there are 5600 different ones and only the
printed page knows what they say. A rubric is the opposite -- IELTS reuses a
closed set of about thirty sentences, parameterised by a word limit, a letter
range or a passage number. So a rubric does not have to be *transcribed*, only
*recognised*: the OCR line is matched against the canonical templates below and
the canonical text is written out. OCR noise ("anSwer", "woRD", "lertter",
"ANDIOR") is therefore repaired rather than propagated, which is the opposite
of what a free-text transcription would do.

Anything that does not match a template is never guessed. It is reported as
LOW and goes to the page-reading worklist instead.

    python scripts/repair/60_recover_rubrics.py                 # report only
    python scripts/repair/60_recover_rubrics.py --apply         # write HIGH
    python scripts/repair/60_recover_rubrics.py --books 10,16
"""
from __future__ import annotations

import argparse
import difflib
import json
import re
import sys
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import BOOKS, FIXTURES, REPAIR, ROOT, load_markdown, read_json, write_json  # noqa: E402

PLACEHOLDER_INSTRUCTIONS = {
    "write the answer from the source question",
    "answer the question from the source",
    "see the source question",
    "", "todo", "placeholder", "n/a", "-",
}

# ---------------------------------------------------------------------------
# The canonical rubric library.
#
# Each entry is (pattern, builder). The pattern is matched against a *loosened*
# form of the OCR line -- case-folded, with the characters OCR most often
# mangles treated as interchangeable -- and the builder re-emits the sentence
# in its canonical form using the captured parameters. Nothing outside this
# table is ever written to a fixture.
#
# Sources for the wording: the printed rubrics in Cambridge IELTS 4-21, which
# are identical across books apart from the parameters captured here.
# ---------------------------------------------------------------------------

NUMBER_WORDS = "ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN"


def _n(word: str) -> str:
    return word.upper()


RUBRICS: list[tuple[str, Callable[[re.Match[str]], str]]] = [
    # -- multiple choice ----------------------------------------------------
    (r"choose the correct letter[ ,]+a[ ,]+b[ ,]+c,? or d",
     lambda m: "Choose the correct letter, A, B, C or D."),
    # "lertter", "lelter" -- the doubled-consonant OCR slip on this one word is
    # common enough to spell out rather than fuzz the whole line.
    (r"choose the correct le\w{0,3}ter[ ,]+a[ ,]+b,?\s*or\s*c\b",
     lambda m: "Choose the correct letter, A, B or C."),
    (r"choose the correct le\w{0,3}ter[ ,]+a[ ,]+b[ ,]+c,?\s*or\s*d\b",
     lambda m: "Choose the correct letter, A, B, C or D."),
    (r"choose (%s) letters?[ ,]+a\s*[-–—]\s*([a-k])" % NUMBER_WORDS,
     lambda m: f"Choose {_n(m.group(1))} letters, A-{m.group(2).upper()}."),
    (r"choose the (%s) correct answers?" % NUMBER_WORDS,
     lambda m: f"Choose the {_n(m.group(1))} correct answers."),
    # -- headings -----------------------------------------------------------
    (r"choose the correct heading for each (paragraph|section)",
     lambda m: f"Choose the correct heading for each {m.group(1)} "
               f"from the list of headings below."),
    (r"which (paragraph|section) contains the following information",
     lambda m: f"Which {m.group(1)} contains the following information?"),
    (r"reading passage \d+ has (%s|\d+) (paragraphs|sections)" % NUMBER_WORDS,
     lambda m: f"Reading Passage has {m.group(1).lower()} {m.group(2)}."),
    # -- true / false / not given ------------------------------------------
    (r"do the following ?statements refle[ec]t the (opinion|claims|views)"
     r"[^?]*?(?:reading )?passage\s*(\d)",
     lambda m: (f"Do the following statements reflect the {m.group(1)} of the writer "
                f"in Reading Passage {m.group(2)}?")),
    (r"do the following ?statements agree with the (information|claims|views)"
     r"[^?]*?(?:reading )?passage\s*(\d)",
     lambda m: (f"Do the following statements agree with the "
                f"{'information given' if m.group(1) == 'information' else m.group(1) + ' of the writer'} "
                f"in Reading Passage {m.group(2)}?")),
    (r"do the following ?statements agree with the (information|claims|views)",
     lambda m: (f"Do the following statements agree with the "
                f"{'information given' if m.group(1) == 'information' else m.group(1) + ' of the writer'} "
                f"in the text?")),
    # -- completion: what to complete ---------------------------------------
    (r"complete the (notes|table|form|summary|sentences|flow[- ]?chart|diagram|"
     r"plan|map|labels|chart)\b",
     lambda m: f"Complete the {m.group(1).replace('flowchart', 'flow-chart').replace('flow chart', 'flow-chart')} below."),
    (r"complete each sentence with the correct ending[ ,]+a\s*[-–—]\s*([a-k])",
     lambda m: f"Complete each sentence with the correct ending, A-{m.group(1).upper()}, below."),
    (r"label the (map|plan|diagram|chart)\b",
     lambda m: f"Label the {m.group(1)} below."),
    # -- completion: the word limit ----------------------------------------
    (r"write (%s) words? and\W{0,3}or a number for each answ" % NUMBER_WORDS,
     lambda m: f"Write {_n(m.group(1))} WORD AND/OR A NUMBER for each answer."),
    (r"write no more than (%s) words? and\W{0,3}or a number for each answ" % NUMBER_WORDS,
     lambda m: f"Write NO MORE THAN {_n(m.group(1))} WORDS AND/OR A NUMBER for each answer."),
    (r"write no more than (%s) words? for each answ" % NUMBER_WORDS,
     lambda m: f"Write NO MORE THAN {_n(m.group(1))} WORDS for each answer."),
    (r"write (%s) word ?only for each answ" % NUMBER_WORDS,
     lambda m: f"Write {_n(m.group(1))} WORD ONLY for each answer."),
    # The plain form, without "ONLY" and without "NO MORE THAN". Listed after
    # both so those never fall through to it.
    (r"write (%s) words? for each answ" % NUMBER_WORDS,
     lambda m: f"Write {_n(m.group(1))} WORD for each answer."),
    (r"choose (%s) word ?only from the (?:passage|text) for each answ" % NUMBER_WORDS,
     lambda m: f"Choose {_n(m.group(1))} WORD ONLY from the passage for each answer."),
    (r"choose no more than (%s) words?(?: and\W{0,3}or a number)? from "
     r"(?:reading )?passage\s*(\d) for each answ" % NUMBER_WORDS,
     lambda m: f"Choose NO MORE THAN {_n(m.group(1))} WORDS from Reading Passage {m.group(2)} for each answer."),
    (r"choose no more than (%s) words?(?: and\W{0,3}or a number)? from the "
     r"(?:passage|text) for each answ" % NUMBER_WORDS,
     lambda m: f"Choose NO MORE THAN {_n(m.group(1))} WORDS from the passage for each answer."),
    # -- matching / boxes ---------------------------------------------------
    (r"choose (%s) answers? from the box and write the correct letter"
     r"[ ,]+a\s*[-–—]\s*([a-k])[ ,]*next to questions? *(\d+)\s*[-–—]\s*(\d+)" % NUMBER_WORDS,
     lambda m: (f"Choose {_n(m.group(1))} answers from the box and write the correct "
                f"letter, A-{m.group(2).upper()}, next to Questions {m.group(3)}-{m.group(4)}.")),
    (r"choose (%s) answers? from the box and write the correct letter"
     r"[ ,]+a\s*[-–—]\s*([a-k])" % NUMBER_WORDS,
     lambda m: (f"Choose {_n(m.group(1))} answers from the box and write the correct "
                f"letter, A-{m.group(2).upper()}.")),
    # The thing being matched varies by paper (person, expert, researcher,
    # theory ...), so it is captured rather than fixed.
    (r"match each (\w+) with the correct (\w+)[^.]*?a[ ,]+b[ ,]+c,?\s*or\s*d\b",
     lambda m: f"Match each {m.group(1)} with the correct {m.group(2)}, A, B, C or D."),
    (r"match each (\w+) with the correct (\w+)[^.]*?a[ ,]+b,?\s*or\s*c\b",
     lambda m: f"Match each {m.group(1)} with the correct {m.group(2)}, A, B or C."),
    (r"match each (\w+) with the correct (\w+)(?: or \w+)?[ ,]+a\s*[-–—]\s*([a-k])",
     lambda m: f"Match each {m.group(1)} with the correct {m.group(2)}, A-{m.group(3).upper()}."),
    # A supplementary line that names the letter range and the question span.
    (r"write the correct letters?[ ,]+a[ ,]+b,?\s*or\s*c[ ,]+next to questions? *"
     r"(\d+)\s*[-–—]\s*(\d+)",
     lambda m: f"Write the correct letter, A, B or C, next to Questions {m.group(1)}-{m.group(2)}."),
    (r"write the correct letters?[ ,]+a\s*[-–—]\s*([a-k])[ ,]+next to questions? *"
     r"(\d+)\s*[-–—]\s*(\d+)",
     lambda m: (f"Write the correct letter, A-{m.group(1).upper()}, "
                f"next to Questions {m.group(2)}-{m.group(3)}.")),
    (r"write the correct letter[ ,]+a\s*[-–—]\s*([a-k])",
     lambda m: f"Write the correct letter, A-{m.group(1).upper()}, next to each question."),
    (r"classify the following",
     lambda m: "Classify the following statements."),
    # -- short answer -------------------------------------------------------
    (r"answer the questions? below",
     lambda m: "Answer the questions below."),
    (r"look at the following (statements|events|descriptions|people)",
     lambda m: f"Look at the following {m.group(1)}."),
]

COMPILED = [(re.compile(pattern, re.I), builder) for pattern, builder in RUBRICS]

# Lines that open a rubric. Used only to decide which OCR lines are worth
# testing against the templates -- never to accept a line on its own.
RUBRIC_HINT = re.compile(
    r"^(complete|choose|write|do the following|which paragraph|which section|"
    r"label|answer the|reading passage|match each|classify|look at|the text has)",
    re.I)
# A rubric never runs this long; anything longer is body text that happens to
# start with "Complete".
MAX_RUBRIC_CHARS = 160


def loosen(line: str) -> str:
    """Fold the differences OCR invents but a reader would never notice."""
    text = line.strip().lstrip("#").strip().strip("*_")
    text = text.replace("’", "'").replace("‘", "'")
    # "ANDIOR" / "AND1OR" -> "and/or"; the slash is what OCR loses most often.
    text = re.sub(r"\bAND\s*[I1l|/]\s*OR\b", "and/or", text, flags=re.I)
    # OCR drops spaces often enough to matter: "ChooseTWO letters", "A, Bor C",
    # "next toQuestions15-20". Only these known rubric tokens are de-glued, so
    # ordinary CamelCase in body text is left alone.
    text = re.sub(r"\b(Choose|Complete|Write|Match|Label|Classify|Answer)(?=[A-Z])",
                  r"\1 ", text)
    text = re.sub(r"\b([A-J])or\b", r"\1 or", text)
    text = re.sub(r"\b(to|next)(Questions?)\b", r"\1 \2", text, flags=re.I)
    text = re.sub(r"\b(Questions?)(\d)", r"\1 \2", text, flags=re.I)
    text = re.sub(r"\s+", " ", text)
    return text


def canonicalise(line: str) -> str | None:
    """The canonical rubric this OCR line is, or None if it is not one."""
    text = loosen(line)
    if not text or len(text) > MAX_RUBRIC_CHARS or not RUBRIC_HINT.match(text):
        return None
    for pattern, builder in COMPILED:
        match = pattern.search(text)
        if match:
            return builder(match)
    return None


def rubric_lines(chunk: str, limit: int = 8) -> list[str]:
    """The candidate rubric lines at the top of a "Questions a-b" block."""
    out: list[str] = []
    for raw in chunk.split("\n")[1:]:
        line = loosen(raw)
        if not line:
            continue
        if len(out) >= limit:
            break
        out.append(line)
    return out


def recover_for_marker(markdown: str, markers: list[dict[str, Any]], index: int) -> dict[str, Any]:
    """Canonical rubric sentences printed under one "Questions a-b" heading."""
    marker = markers[index]
    following = markers[index + 1]["pos"] if index + 1 < len(markers) else marker["pos"] + 1400
    chunk = markdown[marker["pos"]:min(following, marker["pos"] + 1400)]
    canonical: list[str] = []
    rejected: list[str] = []
    for line in rubric_lines(chunk):
        hit = canonicalise(line)
        if hit:
            if hit not in canonical:
                canonical.append(hit)
        elif RUBRIC_HINT.match(line):
            rejected.append(line)
    return {"canonical": canonical, "rejected": rejected,
            "range": [marker["first"], marker["last"]]}


def enclosing_marker(markers: list[dict[str, Any]], number: int) -> int | None:
    """Index of the narrowest "Questions a-b" heading covering this question."""
    hits = [i for i, m in enumerate(markers) if m["first"] <= number <= m["last"]]
    if not hits:
        return None
    return min(hits, key=lambda i: markers[i]["last"] - markers[i]["first"])


def is_placeholder(instruction: str) -> bool:
    return instruction.strip().lower().rstrip(".") in {
        p.rstrip(".") for p in PLACEHOLDER_INSTRUCTIONS}


def similar(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, a.lower(), b.lower()).ratio()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--books", type=str, default="")
    parser.add_argument("--apply", action="store_true",
                        help="write HIGH-confidence rubrics into the fixtures")
    parser.add_argument("--clean-existing", action="store_true",
                        help="also canonicalise rubrics that are present but OCR-mangled")
    parser.add_argument("--out", type=Path, default=REPAIR / "rubric-recovery.json")
    args = parser.parse_args()

    index = read_json(REPAIR / "source-index.json")
    papers = {p["examId"]: p for b in index["books"] for p in b["papers"] if not p["extra"]}
    books = [int(b) for b in args.books.split(",") if b.strip()] or list(BOOKS)
    markdown_cache: dict[int, str] = {}

    results: list[dict[str, Any]] = []
    counts = {"high": 0, "low": 0, "cleaned": 0, "mismatched": 0,
              "unmapped": 0, "already-ok": 0}

    for path in sorted(FIXTURES.glob("*.json")):
        exam = read_json(path)
        if exam.get("module") == "writing":
            continue
        paper = papers.get(str(exam.get("id")))
        if paper is None or paper["book"] not in books:
            continue
        book = paper["book"]
        if book not in markdown_cache:
            markdown_cache[book] = load_markdown(book)
        markdown = markdown_cache[book]
        markers = sorted(paper["markers"], key=lambda m: m["pos"])
        changed = False

        for section in exam.get("sections") or []:
            for group in section.get("questionGroups") or []:
                numbers = [q["number"] for q in (group.get("questions") or [])
                           if isinstance(q.get("number"), int)]
                if not numbers:
                    continue
                current = str(group.get("instruction") or "")
                placeholder = is_placeholder(current)
                if not placeholder and not args.clean_existing:
                    counts["already-ok"] += 1
                    continue

                position = enclosing_marker(markers, min(numbers))
                if position is None:
                    counts["unmapped"] += 1
                    results.append({"exam": exam["id"], "group": group.get("id"),
                                    "numbers": numbers, "confidence": "LOW",
                                    "reason": "no enclosing 'Questions a-b' heading in the markdown"})
                    continue
                found = recover_for_marker(markdown, markers, position)
                canonical = found["canonical"]

                if not canonical:
                    counts["low"] += 1
                    results.append({"exam": exam["id"], "group": group.get("id"),
                                    "numbers": numbers, "confidence": "LOW",
                                    "headingRange": found["range"],
                                    "reason": "no line under the heading matches a known rubric",
                                    "rejectedLines": found["rejected"][:4]})
                    continue

                instruction = " ".join(canonical)
                if not placeholder:
                    if instruction == current.strip():
                        counts["already-ok"] += 1
                        continue
                    # A single-question group is an importer artefact: it never
                    # had a rubric authored for it, it inherited whichever text
                    # happened to be adjacent. That is how a listening paper
                    # ended up telling the test-taker to consult "Reading
                    # Passage 1". The enclosing "Questions a-b" heading is
                    # derived from the question number and is reliable, so for
                    # these the recovered rubric simply wins.
                    #
                    # A multi-question group was grouped deliberately, so only
                    # correct it when the canonical form is recognisably the
                    # same sentence -- i.e. OCR noise, not a different rubric.
                    if len(numbers) > 1 and similar(current, instruction) < 0.72:
                        counts["already-ok"] += 1
                        continue
                    counts["mismatched" if similar(current, instruction) < 0.72
                           else "cleaned"] += 1
                else:
                    counts["high"] += 1
                results.append({"exam": exam["id"], "group": group.get("id"),
                                "numbers": numbers, "confidence": "HIGH",
                                "headingRange": found["range"],
                                "was": current, "instruction": instruction})
                if args.apply:
                    group["instruction"] = instruction
                    group["repairSource"] = {
                        "kind": "rubric-recovery",
                        "headingRange": found["range"],
                        "canonicalOf": found["rejected"][:1] or None,
                    }
                    changed = True

        if args.apply and changed:
            backup = path.with_suffix(".json.bak")
            if not backup.exists():
                backup.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
            path.write_text(json.dumps(exam, ensure_ascii=False, indent=2) + "\n",
                            encoding="utf-8")

    write_json(args.out, {"schemaVersion": 1, "counts": counts, "groups": results})
    print(json.dumps(counts, ensure_ascii=False))
    print(f"{counts['high']} rubrics recovered, {counts['cleaned']} OCR-mangled rubrics cleaned, "
          f"{counts['mismatched']} groups were showing another question type's rubric, "
          f"{counts['low'] + counts['unmapped']} left for a human")
    print(f"report → {args.out}")
    if not args.apply:
        print("(report only; rerun with --apply to write the HIGH ones into the fixtures)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
