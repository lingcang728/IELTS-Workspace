# -*- coding: utf-8 -*-
"""Stage 2 — recover question stems from the MinerU markdown.

This is not a general markdown parser and must not become one. The answer key
in ``fixtures/cambridge/`` was proof-read separately and is trusted, so it is
used as the anchor: for a section we already know it holds questions 11-20, and
the job is to find *those numbers, in that order* inside the section's markdown
range and take the text that follows each one.

Three failure modes are real and were measured on the corpus before this was
written, so the parser handles all three rather than assuming clean input:

1. **The number can be missing entirely.** In C10 Test 1 Reading, "In boxes
   8-13 ... write" is followed directly by "China's transport system..." with
   no "8" prefix. So a stem is also accepted at the position where the previous
   stem ended.
2. **The number can be glued to the stem** -- ``9Tea and beer``,
   ``12People in Britain``, ``the park's5``.
3. **OCR corrupts letters.** ``ou should spend about`` (missing Y),
   ``Peading Passage 2`` (R read as P). No parser can fix those, so they are
   *detected* by heuristic and pushed to the human review queue instead of
   being silently accepted.

Every question therefore comes out with a confidence band:

  HIGH   -- number located in sequence, stem looks like a stem, and (for
            option questions) the accepted answer is one of the parsed options
  MEDIUM -- something was inferred: number reconstructed, stem suspiciously
            short, or an OCR-damage heuristic fired. A human must read it.
  LOW    -- not located at all, or the options do not support the answer key.
            A human must rewrite it.

Output: ``data-dev/repair/parsed/{exam-id}.json``.
"""
from __future__ import annotations

import argparse
import html
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import (  # noqa: E402
    BOOKS,
    DASH_CLASS,
    REPAIR,
    exam_id,
    load_exam,
    load_markdown,
    read_json,
    squash,
    write_json,
)

TAG_RE = re.compile(r"<[^>]+>")
OPTION_LINE_RE = re.compile(r"^\(?([A-J])[).:]?\s+(?=\S)", re.M)
ROMAN_LINE_RE = re.compile(r"^\(?(i{1,3}|iv|vi{0,3}|ix|xi{0,3}|x)[).:]?\s+(?=\S)", re.M | re.I)
INSTRUCTION_RE = re.compile(
    r"^(?:Complete|Choose|Write|Answer|Do the following|Label|Match|Which|Look at|"
    r"Classify|Reading Passage|In boxes|Questions?)\b",
    re.I,
)
# Stems that are really the group instruction leaking into the question slot.
INSTRUCTION_ONLY_RE = re.compile(
    r"^(?:Complete|Choose|Write|Answer|Label|Match|Classify|Do the following)\b.*\.$",
    re.I,
)
SINGLE_LETTER_RE = re.compile(r"^[A-J]$")
ROMAN_RE = re.compile(r"^(?:i{1,3}|iv|vi{0,3}|ix|xi{0,3}|x)$", re.I)
# OCR damage heuristics. A plain lowercase first letter is NOT one of them:
# "Which paragraph contains ... a description of an early invention" style
# stems legitimately start lowercase all over the corpus, and flagging those
# pushed 4 clean questions per paper into the review queue for nothing. What is
# genuinely suspicious is a *truncated* first word ("ou should spend about"),
# a letter pair OCR confuses, or a character that has no business in a stem.
OCR_SUSPECT_RES = (
    re.compile(r"\b(?:rn|l1|0O|O0)\w"),
    re.compile(r"^[a-z]{1,3}\s+(?:should|are|is|was|were|have|has|can|will|would)\b"),
    re.compile(r"\b[A-Z]{2,}[a-z]{3,}\b"),
    # Bullets are normal in Cambridge note-completion layouts, and "|" is this
    # script's own table-row separator, so neither is evidence of OCR damage.
    re.compile(r"[^\s\w,.;:!?'‘’“”\"()\[\]/%&$£€–—|•·*°+=@#~^<>{}\\-]"),
    # Lost word spacing: "aswith most ganzfeldstudies", "theamount of".
    re.compile(r"\b[a-z]{16,}\b"),
    re.compile(r"[a-z]{2}[A-Z][a-z]{2}"),
    # A stranded single letter before punctuation, as in "response t .which".
    re.compile(r"\s[b-hj-z]\s*[.,]"),
)
# When the answer is a word but the stem carries an "A ... B ... C" ladder, the
# stem has swallowed the multiple-choice question that follows it.
CHOICE_LADDER_RE = re.compile(r"\bA\s+\S.*?\bB\s+\S.*?\bC\s+\S", re.S)
# Words a stem may legitimately open with in lower case.
LOWER_OPENERS = {
    "a", "an", "the", "to", "how", "why", "what", "when", "where", "which", "who",
    "details", "description", "reference", "mention", "examples", "example", "in",
    "of", "for", "and", "or", "not", "no", "one", "two", "some", "many", "most",
}

HIGH, MEDIUM, LOW = "HIGH", "MEDIUM", "LOW"
MIN_STEM = 15


def plain_text(markdown: str) -> str:
    """Markdown region -> readable text, tables flattened into ' | ' rows."""
    def table_to_text(match: re.Match[str]) -> str:
        rows = re.findall(r"<tr>(.*?)</tr>", match.group(0), flags=re.S | re.I)
        lines = []
        for row in rows:
            cells = [squash(html.unescape(TAG_RE.sub(" ", cell)))
                     for cell in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, flags=re.S | re.I)]
            cells = [c for c in cells if c]
            if cells:
                lines.append(" | ".join(cells))
        return "\n" + "\n".join(lines) + "\n"

    text = re.sub(r"<table>.*?</table>", table_to_text, markdown, flags=re.S | re.I)
    text = html.unescape(TAG_RE.sub(" ", text))
    text = re.sub(r"^#{1,6}\s*", "", text, flags=re.M)
    # MinerU escapes markdown punctuation, so a note-completion gap arrives as
    # "\_\_\_\_\_" and a stem keeps stray backslashes unless they are undone.
    text = re.sub(r"\\([\\`*_{}\[\]()#+.!-])", r"\1", text)
    return text


def number_positions(text: str, numbers: list[int]) -> dict[int, int]:
    """Locate each expected question number, in order, scanning forward only.

    Scanning forward from the previous hit is what makes glued numbers safe:
    ``9Tea and beer`` matches because the pattern does not require a following
    space, and a stray "9" inside an earlier sentence cannot steal the slot
    because that region has already been consumed.
    """
    found: dict[int, int] = {}
    cursor = 0
    for number in numbers:
        pattern = re.compile(r"(?<![\d.])" + str(number) + r"(?![\d])")
        best = None
        for match in pattern.finditer(text, cursor):
            after = text[match.end(): match.end() + 60]
            before = text[max(0, match.start() - 30): match.start()]
            # Reject "Questions 9-13", "in boxes 9-13", "page 9" and friends.
            if re.search(r"(?:question|box|page|line|passage|section|part)s?\s*$", before, re.I):
                continue
            if re.match(r"\s*" + DASH_CLASS + r"\s*\d", after):
                continue
            if not after.strip():
                continue
            best = match.start()
            break
        if best is not None:
            found[number] = best
            cursor = best + len(str(number))
    return found


def clean_stem(raw: str) -> str:
    stem = squash(raw)
    stem = re.sub(r"^[).:\s]+", "", stem)
    # Drop a trailing "Questions 14-18" that belongs to the next group.
    stem = re.split(r"\bQuestions?\s+\d{1,2}\s*" + DASH_CLASS, stem)[0]
    return stem.strip()


def _candidate_options(block: str, pattern: re.Pattern[str], kind: str) -> list[dict[str, str]]:
    hits = list(pattern.finditer(block))
    if len(hits) < 2:
        return []
    out: list[dict[str, str]] = []
    for index, hit in enumerate(hits):
        stop = hits[index + 1].start() if index + 1 < len(hits) else min(len(block), hit.end() + 200)
        text = squash(block[hit.end():stop])
        if not text:
            continue
        out.append({"id": hit.group(1).lower() if kind == "roman" else hit.group(1).upper(),
                    "label": hit.group(1), "text": text})
    return out


def parse_options(block: str, accepted: list[str]) -> list[dict[str, str]]:
    """Pull an A/B/C or i/ii/iii option list out of a block of text.

    Naively taking the first letter-labelled list is wrong: a reading passage
    whose paragraphs are labelled ``A``, ``B``, ``C`` sits in the same region
    and looks exactly like an option list, only with 800-character "options".
    So candidates are scored -- option texts are short, and the right list is
    the one whose labels actually cover the answer key.
    """
    wanted = {a.strip().lower() for a in accepted}
    candidates = [
        _candidate_options(block, ROMAN_LINE_RE, "roman"),
        _candidate_options(block, OPTION_LINE_RE, "letter"),
    ]
    best: list[dict[str, str]] = []
    best_score = -1.0
    for options in candidates:
        if len(options) < 2:
            continue
        lengths = sorted(len(o["text"]) for o in options)
        median = lengths[len(lengths) // 2]
        if median > 200:
            continue  # a passage, not an option list
        labels = {o["id"].lower() for o in options}
        covers = bool(wanted) and wanted <= labels
        score = (2.0 if covers else 0.0) + min(len(options), 12) / 100.0 - median / 10000.0
        if score > best_score:
            best_score, best = score, options
    return best


def ocr_suspect(stem: str) -> str | None:
    for pattern in OCR_SUSPECT_RES:
        if pattern.search(stem):
            return pattern.pattern
    if stem and stem[0].islower():
        first = re.match(r"[a-z']+", stem)
        if first and first.group(0) not in LOWER_OPENERS:
            return f"starts with lowercase {first.group(0)!r}"
    return None


def score_question(question: dict[str, Any], stem: str, options: list[dict[str, str]],
                   located: bool, inferred: bool) -> tuple[str, list[str]]:
    reasons: list[str] = []
    accepted = [str(a).strip() for a in (question.get("acceptedAnswers") or []) if str(a).strip()]
    wants_options = bool(accepted) and all(
        SINGLE_LETTER_RE.fullmatch(a) or ROMAN_RE.fullmatch(a) for a in accepted
    )

    if not located:
        return LOW, ["question number not found in the section text"]
    if not stem:
        return LOW, ["no stem text after the question number"]
    if not re.search(r"[A-Za-z]{3}", stem):
        return LOW, [f"stem has no readable words: {stem[:40]!r}"]
    if wants_options:
        labels = {o["id"].upper() for o in options} | {o["id"] for o in options}
        if not options:
            return LOW, [f"answers are option labels {accepted} but no option list was parsed"]
        missing = [a for a in accepted if a.upper() not in labels and a.lower() not in labels]
        if missing:
            return LOW, [f"accepted answers {missing} are not among the parsed options"]

    if inferred:
        reasons.append("question number was reconstructed, not found")
    # Matching stems are legitimately terse ("Paragraph A", "Section C"), so a
    # short stem only counts against a question that carries no option list to
    # give it meaning.
    floor = 8 if options else MIN_STEM
    if len(stem) < floor:
        reasons.append(f"stem is only {len(stem)} characters")
    if INSTRUCTION_ONLY_RE.match(stem):
        reasons.append("stem looks like the group instruction, not a question")
    if not wants_options and CHOICE_LADDER_RE.search(stem):
        reasons.append("stem contains an A/B/C option ladder but the answer is a word")
    suspect = ocr_suspect(stem)
    if suspect:
        reasons.append(f"possible OCR damage ({suspect})")
    return (MEDIUM if reasons else HIGH), reasons


def parse_section(text: str, section_index: dict[str, Any], exam_section: dict[str, Any],
                  module: str) -> list[dict[str, Any]]:
    start = section_index.get("questionStart") if module == "reading" else section_index["start"]
    region = plain_text(text[start: section_index["end"]])

    questions = [q for g in exam_section.get("questionGroups") or []
                 for q in g.get("questions") or []]
    groups_by_question = {q["id"]: g for g in exam_section.get("questionGroups") or []
                          for q in g.get("questions") or []}
    numbers = [q["number"] for q in questions if isinstance(q.get("number"), int)]
    positions = number_positions(region, numbers)

    out: list[dict[str, Any]] = []
    seen_stems: dict[str, int] = {}
    for index, question in enumerate(questions):
        number = question.get("number")
        accepted = [str(a).strip() for a in (question.get("acceptedAnswers") or []) if str(a).strip()]
        located = number in positions
        inferred = False
        if located:
            begin = positions[number] + len(str(number))
        else:
            # Failure mode 1: the number was dropped. Start where the previous
            # stem ended, which is where it would have been printed.
            previous = next((positions[n] for n in reversed(numbers[:index]) if n in positions), None)
            if previous is None:
                out.append(build(question, "", [], False, False, LOW,
                                 ["question number not found in the section text"]))
                continue
            begin = previous
            inferred = True

        following = next((positions[n] for n in numbers[index + 1:] if n in positions), None)
        stop = following if following is not None else len(region)
        block = region[begin:stop]
        stem_raw = block.split("\n\n")[0] if "\n\n" in block[:400] else block
        stem = clean_stem(stem_raw[:400])
        options = parse_options(block, accepted) or parse_options(region, accepted)
        band, reasons = score_question(question, stem, options, located or inferred, inferred)
        # A reconstructed number that lands on a stem already used belongs to
        # the previous question, not this one -- that is a miss, not a guess.
        if stem and stem in seen_stems:
            band = LOW
            reasons = [f"stem is identical to question {seen_stems[stem]}"]
        elif stem:
            seen_stems[stem] = number
        group = groups_by_question.get(question["id"], {})
        out.append(build(question, stem, options, located, inferred, band, reasons,
                         group_type=group.get("questionType")))
    return out


def build(question: dict[str, Any], stem: str, options: list[dict[str, str]],
          located: bool, inferred: bool, band: str, reasons: list[str],
          group_type: str | None = None) -> dict[str, Any]:
    accepted = [str(a).strip() for a in (question.get("acceptedAnswers") or []) if str(a).strip()]
    wants_options = bool(accepted) and all(
        SINGLE_LETTER_RE.fullmatch(a) or ROMAN_RE.fullmatch(a) for a in accepted
    )
    suggested_type = question.get("type")
    if wants_options and suggested_type not in {"single_choice", "multi_choice", "matching", "labelling"}:
        # A lowercase roman answer is a List of Headings match; a bare capital
        # is a choice or a matching pick. Either way it is not a text gap.
        suggested_type = "matching" if all(ROMAN_RE.fullmatch(a) for a in accepted) else "single_choice"
    return {
        "questionId": question["id"],
        "number": question.get("number"),
        "currentType": question.get("type"),
        "groupType": group_type,
        "suggestedType": suggested_type,
        "acceptedAnswers": accepted,
        "prompt": stem,
        "options": options if wants_options else [],
        "located": located,
        "numberInferred": inferred,
        "confidence": band,
        "reasons": reasons,
    }


def parse_exam(book: int, test: int, module: str, index: dict[str, Any],
               text: str) -> dict[str, Any] | None:
    exam = load_exam(book, test, module)
    if exam is None:
        return None
    record = next((b for b in index["books"] if b["book"] == book), None)
    if record is None:
        return None
    paper = next((p for p in record["papers"]
                  if p["module"] == module and p["test"] == test and not p["extra"]), None)
    if paper is None:
        return None

    results: list[dict[str, Any]] = []
    for position, section_index in enumerate(paper["sections"]):
        if position >= len(exam["sections"]):
            break
        results.extend(parse_section(text, section_index, exam["sections"][position], module))
    bands = {band: sum(1 for r in results if r["confidence"] == band) for band in (HIGH, MEDIUM, LOW)}
    return {
        "schemaVersion": 1,
        "examId": exam_id(book, test, module),
        "book": book,
        "test": test,
        "module": module,
        "counts": bands,
        "questions": results,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--books", type=str, default="", help="e.g. 8,6 for batch 0")
    parser.add_argument("--index", type=Path, default=REPAIR / "source-index.json")
    parser.add_argument("--out", type=Path, default=REPAIR / "parsed")
    args = parser.parse_args()
    index = read_json(args.index)
    books = [int(b) for b in args.books.split(",") if b.strip()] or list(BOOKS)

    totals = {HIGH: 0, MEDIUM: 0, LOW: 0}
    print(f"{'Exam':<34}{'HIGH':>6}{'MED':>6}{'LOW':>6}")
    for book in books:
        text = load_markdown(book)
        for test in (1, 2, 3, 4):
            for module in ("listening", "reading"):
                parsed = parse_exam(book, test, module, index, text)
                if parsed is None:
                    continue
                write_json(args.out / f"{parsed['examId']}.json", parsed)
                counts = parsed["counts"]
                for band in totals:
                    totals[band] += counts[band]
                print(f"{parsed['examId']:<34}{counts[HIGH]:>6}{counts[MEDIUM]:>6}{counts[LOW]:>6}")

    total = sum(totals.values())
    print("-" * 52)
    print(f"{'TOTAL':<34}{totals[HIGH]:>6}{totals[MEDIUM]:>6}{totals[LOW]:>6}")
    if total:
        print(f"\nHIGH {totals[HIGH] * 100 // total}% auto-pass (spot-check 10% per book)")
        print(f"MEDIUM+LOW {(totals[MEDIUM] + totals[LOW]) * 100 // total}% "
              f"= {totals[MEDIUM] + totals[LOW]} questions need a human")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
