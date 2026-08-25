# -*- coding: utf-8 -*-
"""Stage 6d — turn overlay *diagnoses* into option structure.

Round 4 left 349 groups still stamped with the importer's default ``A``-``H``
empty slots. Proofreaders looking at the printed page could only flag them:
the submit checker demanded text for every declared label, and inventing
``E``-``H`` was forbidden. Their notes already say what the page actually is.
This script reads those notes, cross-checks the answer key (the only source
the importer did not contaminate with the A-H default), and rewrites the
*declared* type and option width. It never writes option wording that is not
already a structural label (``A``, ``Paragraph B``).

    python scripts/repair/67_fix_declared_structure.py --dry-run
    python scripts/repair/67_fix_declared_structure.py

Hard rules, inherited from 64 and the 2026-08-25 handoff:

  * an option that already carries text is never deleted or overwritten
  * the answer key is a lower bound and a falsifier, not a width
  * note, rubric, options and key each may be wrong; a change needs two
    sources that do not contradict, or a key that independently proves type
  * fixtures are gitignored: every written file gets a .bak
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "fixtures" / "cambridge"
OVERLAYS = ROOT / "fixtures" / "overlays"
REPAIR = ROOT / "data-dev" / "repair"
REPORT_PATH = REPAIR / "structure-fix-report.json"
MISSING_PATH = REPAIR / "known-missing-scans.json"

AH = list("ABCDEFGH")
ROMAN = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii"]
ROMAN_SET = set(ROMAN)
AMBIGUOUS_ROMAN = {"i", "v", "x"}
# Single letters T/F/Y/N/NG are option labels, not TRUE/FALSE/YES/NO.
TFNG_ANS = {"TRUE", "FALSE", "NOT GIVEN"}
YNNG_ANS = {"YES", "NO", "NOT GIVEN"}
PLACEHOLDER_INSTR = {
    "write the answer from the source question.",
    "write the answer from the source question",
    "answer the question from the source.",
    "see the source question.",
    "todo",
    "placeholder",
    "n/a",
    "-",
    "instruction",
    "instructions",
    "",
}
SINGLE_LETTER_RE = re.compile(r"^[A-P]$", re.I)
WORDISH_RE = re.compile(r"[A-Za-z]{2,}")
MISSING_RE = re.compile(r"缺页|缺失原书印刷页|没被扫|未被扫描|not scanned|pages were not", re.I)
DECLARED_CTX_RE = re.compile(r"声明|declared|fixture|工单|题库|optionlabels|option labels", re.I)


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def option_text(option: dict) -> str:
    return str(option.get("text") or "").strip()


def option_label(option: dict) -> str:
    return str(option.get("label") or option.get("id") or "").strip()


def all_empty(options: list) -> bool:
    return all(not option_text(o) for o in options)


def is_ah_empty(options: list) -> bool:
    if len(options) != 8:
        return False
    labels = [option_label(o).upper() for o in options]
    return labels == AH and all_empty(options)


def answers_of(group: dict) -> list[str]:
    out: list[str] = []
    for question in group.get("questions") or []:
        for answer in question.get("acceptedAnswers") or []:
            text = str(answer).strip()
            if text:
                out.append(text)
    return out


def norm_ans(answer: str) -> str:
    return " ".join(answer.strip().upper().split())


def letters_used(answers: list[str]) -> set[str]:
    used: set[str] = set()
    for answer in answers:
        if SINGLE_LETTER_RE.fullmatch(answer.strip()):
            used.add(answer.strip().upper())
    return used


def romans_used(answers: list[str]) -> set[str]:
    used: set[str] = set()
    for answer in answers:
        token = answer.strip().lower()
        if token in ROMAN_SET:
            used.add(token)
    return used


def answers_are_tfng(answers: list[str]) -> bool:
    return bool(answers) and all(norm_ans(a) in TFNG_ANS for a in answers)


def answers_are_ynng(answers: list[str]) -> bool:
    values = {norm_ans(a) for a in answers}
    if not answers:
        return False
    if not values <= (YNNG_ANS | {"NOT GIVEN"}):
        return False
    return bool(values & {"YES", "NO", "Y", "N"})


def answers_are_roman(answers: list[str]) -> bool:
    tokens = [a.strip().lower() for a in answers]
    if not tokens or any(t not in ROMAN_SET for t in tokens):
        return False
    return any(t not in AMBIGUOUS_ROMAN for t in tokens) or all(t == "i" for t in tokens)


def answers_are_words(answers: list[str]) -> bool:
    if not answers:
        return False
    for answer in answers:
        token = answer.strip()
        if SINGLE_LETTER_RE.fullmatch(token):
            return False
        if token.lower() in ROMAN_SET:
            return False
        if norm_ans(token) in TFNG_ANS | YNNG_ANS:
            return False
        if not WORDISH_RE.search(token) and not any(ch.isdigit() for ch in token):
            return False
    return True


def is_placeholder_instruction(text: str) -> bool:
    return text.strip().lower().rstrip(".") in {p.rstrip(".") for p in PLACEHOLDER_INSTR}


def letter_range(last: str) -> list[str]:
    last = last.upper()
    if last < "B" or last > "P":
        raise ValueError(last)
    return [chr(code) for code in range(ord("A"), ord(last) + 1)]


def roman_range(last: str) -> list[str]:
    last = last.lower()
    if last not in ROMAN_SET:
        raise ValueError(last)
    return ROMAN[: ROMAN.index(last) + 1]


def make_options(labels: list[str], text_mode: str) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for label in labels:
        if text_mode == "label":
            text = label
        elif text_mode == "paragraph":
            text = f"Paragraph {label}"
        elif text_mode == "section":
            text = f"Section {label}"
        else:
            text = ""
        out.append({"id": label, "label": label, "text": text})
    return out


def snapshot_texted(exam: dict) -> list[tuple[str, str, str, str]]:
    """(groupId, holder, label, text) for every option that already has wording."""
    rows: list[tuple[str, str, str, str]] = []
    for section in exam.get("sections") or []:
        for group in section.get("questionGroups") or []:
            gid = str(group.get("id") or "")
            for option in group.get("sharedOptions") or []:
                text = option_text(option)
                if text:
                    rows.append((gid, "shared", option_label(option), text))
            for question in group.get("questions") or []:
                qid = str(question.get("id") or "")
                for option in question.get("options") or []:
                    text = option_text(option)
                    if text:
                        rows.append((gid, qid, option_label(option), text))
    return rows


def context_is_complaint(note: str, start: int) -> bool:
    return bool(DECLARED_CTX_RE.search(note[max(0, start - 36) : start]))


def last_letter_from_text(text: str, *, ignore_complaint: bool = True) -> str | None:
    """Printed letter width: A-G, A, B, C or D, A、B、C、D, 三项."""
    found: list[str] = []
    for match in re.finditer(r"\bA\s*[-–—]\s*([B-P])\b", text, re.I):
        if ignore_complaint and context_is_complaint(text, match.start()):
            continue
        found.append(match.group(1).upper())
    for match in re.finditer(
        r"\(\s*A\s*,\s*B\s*,\s*C(?:\s*,\s*([D-P]))?(?:\s*,\s*([E-P]))?\s*\)",
        text,
        re.I,
    ):
        found.append((match.group(2) or match.group(1) or "C").upper())
    match = re.search(r"\bA\s*,\s*B\s*,\s*C\s+or\s+([D-P])\b", text, re.I)
    if match:
        found.append(match.group(1).upper())
    match = re.search(
        r"\bA\s*[、,，]\s*B\s*[、,，]\s*C(?:\s*[、,，]\s*([D-P]))?(?:\s*[、,，]\s*([E-P]))?",
        text,
        re.I,
    )
    if match:
        found.append((match.group(2) or match.group(1) or "C").upper())
    if re.search(r"选项仅有\s*A[、,，]B[、,，]C\b|三项（A", text):
        found.append("C")
    if re.search(r"只有\s*A[、,，]B[、,，]C[、,，]D|四项；|四个选项", text):
        found.append("D")
    if not found:
        return None
    preferred = [letter for letter in found if letter != "H"]
    return max(preferred or found)


def letter_range_from_note(note: str) -> str | None:
    return last_letter_from_text(note, ignore_complaint=True)


def option_texts_from_note(note: str) -> dict[str, str] | None:
    """Slash-separated 'A text / B text / C text' copied into the diagnosis."""
    chunks = re.findall(
        r"\b([A-P])\s+([^/（）()]{8,160}?)\s*(?=/|）|\)|$)",
        note,
    )
    if len(chunks) < 2:
        return None
    out: dict[str, str] = {}
    for label, text in chunks:
        cleaned = " ".join(text.split()).strip(" ；;,.，")
        if cleaned:
            out[label.upper()] = cleaned
    return out if len(out) >= 2 else None


def roman_range_from_note(note: str) -> str | None:
    match = re.search(
        r"\b(i{1,3})\s*[-–—]\s*(x?i{0,3}v?i{0,3}x?)\b",
        note,
        re.I,
    )
    if not match:
        return None
    last = match.group(2).lower()
    if last in ROMAN_SET:
        return last
    return None


def extract_quoted_rubric(note: str) -> str | None:
    patterns = [
        r"(Do the following statements agree with[^。.\n]{10,160}\.)",
        r"(Complete the (?:notes|table|form|summary|sentences) below\.[^。.\n]{0,180})",
        r"(Complete each sentence with the correct ending,[^。.\n]{0,80})",
        r"(Which (?:paragraph|section) contains the following information\?[^。.\n]{0,80})",
        r"(Label the (?:map|plan|diagram) below\.[^。.\n]{0,140})",
        r"(Choose the correct heading for each paragraph from the list of headings below\.)",
        r"(Match each (?:statement|person|researcher)[^。.\n]{0,120})",
        r"(Choose (?:TWO|THREE|FOUR|FIVE) letters?,[^。.\n]{0,40})",
    ]
    for pattern in patterns:
        match = re.search(pattern, note, re.I)
        if match:
            text = " ".join(match.group(1).split())
            if 12 <= len(text) <= 220:
                return text
    return None


def classify_note(note: str) -> str:
    n = note.lower()
    if MISSING_RE.search(note):
        return "missing_scan"
    if re.search(r"true\s*/?\s*false|判断题", n) or re.search(
        r"agree with the (information|views|claims)", n
    ):
        if re.search(r"yes\s*/?\s*no", n):
            return "ynng"
        return "tfng"
    if re.search(r"yes\s*/?\s*no", n):
        return "ynng"
    if re.search(r"list of headings|罗马数字|heading", n):
        return "headings"
    if re.search(r"地图|map |plan |diagram|标注|label the", n):
        return "labelling"
    if re.search(
        r"which (?:paragraph|section) contains|段落信息匹配|信息匹配|段落定位",
        n,
    ):
        return "paragraph_match"
    if re.search(r"词库|word bank|选词填空|box below|list of words", n):
        return "word_bank"
    if re.search(r"人物匹配|list of people|correct person", n):
        return "people_match"
    if re.search(r"correct ending|句子结尾|ending, a-", n):
        return "sentence_endings"
    if re.search(
        r"fill-in-the-blank|notes completion|form completion|table completion|"
        r"summary completion with choose one word|sentence completion with choose one word|"
        r"摘要填空|笔记填空|句子填空|表格填空|填空题|one word only from the passage|"
        r"no option list|没有选项|无选项列表|页面没有选项",
        n,
    ):
        return "completion"
    if re.search(r"choose (?:two|three|four|five) letters", n):
        return "multi_choice"
    if re.search(r"分类题|classify", n):
        return "classify"
    if re.search(r"三选一|3-choice|three option", n):
        return "abc"
    if re.search(
        r"单选|4-choice|5-choice|四个选项|五个选项|4 options|5 options|独立选项",
        n,
    ):
        return "mcq"
    if re.search(r"matching|匹配", n):
        return "matching"
    return "other"


def key_proves_type(answers: list[str]) -> str | None:
    if answers_are_tfng(answers):
        return "tfng"
    if answers_are_ynng(answers):
        return "ynng"
    if answers_are_roman(answers):
        return "headings"
    if answers_are_words(answers):
        return "completion"
    return None


def decide(group: dict, note: str, overlay_status: str | None) -> dict[str, Any]:
    """Return a plan or a refusal. Never mutates."""
    answers = answers_of(group)
    letters = letters_used(answers)
    instruction = str(group.get("instruction") or "")
    note_kind = classify_note(note) if note else "no_note"
    key_kind = key_proves_type(answers)
    last_from_note = letter_range_from_note(note) if note else None
    roman_last = roman_range_from_note(note) if note else None

    plan: dict[str, Any] = {
        "noteKind": note_kind,
        "keyKind": key_kind,
        "reason": "",
        "action": None,
        "type": None,
        "labels": None,
        "textMode": "empty",
        "instruction": None,
        "optionTexts": None,
        "skip": False,
    }

    if note_kind == "missing_scan":
        plan["action"] = "skip_missing"
        plan["skip"] = True
        plan["reason"] = "printed pages missing from the scan"
        return plan

    # Key independently proves a type that does not use letter slots.
    if key_kind == "tfng":
        plan.update(action="drop_options", type="true_false_ng", reason="key is TRUE/FALSE/NOT GIVEN")
        return plan
    if key_kind == "ynng":
        plan.update(action="drop_options", type="yes_no_ng", reason="key is YES/NO/NOT GIVEN")
        return plan
    if key_kind == "completion":
        # Note may still say this is a labelled map with a corrupt key
        # like "3 C". Honour an explicit labelling/matching note instead.
        if note_kind not in {"labelling", "headings", "paragraph_match", "word_bank",
                             "people_match", "sentence_endings", "matching", "mcq",
                             "abc", "multi_choice", "classify"}:
            plan.update(action="drop_options", type="completion", reason="key is a written word, not a letter")
            return plan

    if key_kind == "headings" or note_kind == "headings":
        latin_only = letters - {"I", "V", "X"}
        if latin_only:
            plan.update(action="refuse", reason="note/key headings but answers include Latin letters")
            return plan
        if key_kind and key_kind not in {None, "headings"}:
            plan.update(action="refuse", reason=f"note headings vs key {key_kind}")
            return plan
        used = romans_used(answers)
        last = roman_last or "ix"
        if used:
            last = ROMAN[max(ROMAN.index(last), max(ROMAN.index(r) for r in used))]
        plan.update(
            action="set_options",
            type="matching",
            labels=roman_range(last),
            textMode="empty",
            reason=f"List of Headings i-{last}",
        )
        return plan

    instr_is_tfng = bool(re.search(r"TRUE,\s*FALSE or NOT GIVEN|TRUE / FALSE / NOT GIVEN", instruction, re.I))
    instr_is_ynng = bool(re.search(r"YES,\s*NO or NOT GIVEN|YES / NO / NOT GIVEN", instruction, re.I))

    if note_kind == "tfng" or (instr_is_tfng and note_kind in {"tfng", "other", "no_note"}):
        if letters:
            plan.update(action="refuse", reason="note TFNG but key is a Latin letter — key not remapped")
            return plan
        plan.update(action="drop_options", type="true_false_ng", reason="note: TRUE/FALSE/NOT GIVEN")
        return plan
    if note_kind == "ynng" or (instr_is_ynng and note_kind in {"ynng", "other", "no_note"}):
        if letters:
            plan.update(action="refuse", reason="note YNNG but key is a Latin letter — key not remapped")
            return plan
        plan.update(action="drop_options", type="yes_no_ng", reason="note: YES/NO/NOT GIVEN")
        return plan

    if note_kind == "completion":
        if letters:
            plan.update(action="refuse", reason="note completion but key is a letter")
            return plan
        plan.update(action="drop_options", type="completion", reason="note: written-answer completion")
        return plan

    if note_kind == "labelling":
        last = last_from_note or "J"
        instr_m = re.search(r"\bA\s*[-–—]\s*([B-P])\b", instruction, re.I)
        if instr_m:
            last = max(last, instr_m.group(1).upper())
        if letters:
            last = max(last, max(letters))
        if letters and max(letters) > last:
            plan.update(action="refuse", reason="labelling key outside declared map letters")
            return plan
        plan.update(
            action="set_options",
            type="labelling",
            labels=letter_range(last),
            textMode="label",
            reason=f"map/plan letters A-{last}",
        )
        return plan

    if note_kind == "paragraph_match":
        last = last_from_note
        instr_m = re.search(r"\bA\s*[-–—]\s*([B-P])\b", instruction, re.I)
        if instr_m:
            last = last or instr_m.group(1).upper()
        section = bool(re.search(r"section contains|sections a-", note, re.I))
        if not last:
            # Which-paragraph tasks always span the passage letters. Defaulting
            # to A-H here is the page's paragraph run, not the importer stamp:
            # the note already said the options *are* the paragraphs.
            last = "H"
        if letters:
            last = max(last, max(letters))
        mode = "section" if section else "paragraph"
        plan.update(
            action="set_options",
            type="matching",
            labels=letter_range(last),
            textMode=mode,
            reason=f"{mode} matching A-{last}",
        )
        return plan

    if note_kind in {"word_bank", "people_match", "sentence_endings", "matching", "classify", "multi_choice"}:
        last = last_from_note or last_letter_from_text(instruction, ignore_complaint=False)
        texts = option_texts_from_note(note) if note else None
        if not last and texts:
            last = max(texts)
        if not last and note_kind == "classify":
            last = "C"
        if not last and letters:
            plan.update(action="refuse", reason=f"{note_kind} without a printed width")
            return plan
        if not last:
            plan.update(action="refuse", reason=f"{note_kind} without a printed width")
            return plan
        if letters and max(letters) > last:
            last = max(letters)
        qtype = "multi_choice" if note_kind == "multi_choice" else "matching"
        plan.update(
            action="set_options",
            type=qtype,
            labels=letter_range(last),
            textMode="empty",
            optionTexts=texts,
            reason=f"{note_kind} A-{last}",
        )
        return plan

    if note_kind in {"abc", "mcq"} or last_from_note:
        last = last_from_note
        if note_kind == "abc":
            last = last or "C"
        if note_kind == "mcq":
            last = last or "D"
        if not last:
            plan.update(action="refuse", reason="mcq without a printed width")
            return plan
        if letters and max(letters) > last:
            last = max(letters)
        if letters and max(letters) > last:
            plan.update(action="refuse", reason="key letter outside printed MCQ range")
            return plan
        qtype = "matching" if note_kind not in {"abc", "mcq"} else "single_choice"
        # Independent 3/4/5-option items are single_choice; a printed A-G
        # list without a more specific kind is a shared matching box.
        if note_kind not in {"abc", "mcq"}:
            qtype = "matching"
        plan.update(
            action="set_options",
            type=qtype,
            labels=letter_range(last),
            textMode="empty",
            reason=f"{note_kind or 'range'} A-{last}",
        )
        return plan

    # No usable note. Last resort: instruction range that the key does not
    # contradict, only when the instruction is not a placeholder.
    if not is_placeholder_instruction(instruction):
        last = last_letter_from_text(instruction, ignore_complaint=False)
        abc = re.search(r"\bA\s*,?\s*B\s*,?\s*(?:or|and)\s*C\b", instruction, re.I)
        if abc and (not letters or max(letters) <= "C") and not last:
            last = "C"
        if last and re.search(r"choose|letter|ending|person|box|label|classify", instruction, re.I):
            if letters and max(letters) > last:
                last = max(letters)
            if not re.search(r"paragraphs?,?\s*A\s*[-–—]", instruction, re.I):
                plan.update(
                    action="set_options",
                    type="matching" if last >= "F" else "single_choice",
                    labels=letter_range(last),
                    textMode="empty",
                    reason=f"instruction A-{last}",
                )
                return plan

    plan.update(action="refuse", reason="no two sources agree on type/width")
    return plan


def question_texted_lists(group: dict) -> list[list[dict]]:
    lists: list[list[dict]] = []
    for question in group.get("questions") or []:
        options = question.get("options") or []
        if options and not all_empty(options):
            lists.append(options)
    return lists


def reconcile_phantom_shared(group: dict) -> str | None:
    """Empty A-H on the group is the importer stamp; real options live on questions."""
    lists = question_texted_lists(group)
    if not lists:
        return None
    best = max(lists, key=lambda xs: (sum(1 for o in xs if option_text(o)), len(xs)))
    group["sharedOptions"] = [dict(o) for o in best]
    types = [q.get("type") for q in group.get("questions") or [] if q.get("type")]
    if types:
        group["questionType"] = Counter(types).most_common(1)[0][0]
    return f"drop phantom A-H shared; keep {len(best)} texted question options"


def apply_plan(group: dict, plan: dict[str, Any], note: str) -> str | None:
    if plan.get("skip") or plan.get("action") in {None, "refuse", "skip_missing"}:
        return None
    if question_texted_lists(group):
        # Real wording already exists on the questions. Only the empty group
        # stamp is wrong; never rebuild a list that would drop those words.
        return reconcile_phantom_shared(group)

    qtype = plan["type"]
    quoted = extract_quoted_rubric(note) if note else None
    def set_type() -> None:
        group["questionType"] = qtype
        for question in group.get("questions") or []:
            question["type"] = qtype

    if plan["action"] == "drop_options":
        group["sharedOptions"] = []
        for question in group.get("questions") or []:
            if question.get("options") is not None and all_empty(question.get("options") or []):
                question["options"] = []
        set_type()
        if quoted and is_placeholder_instruction(str(group.get("instruction") or "")):
            group["instruction"] = quoted
        return f"drop options, type={qtype}"

    if plan["action"] == "set_options":
        labels: list[str] = plan["labels"]
        options = make_options(labels, plan["textMode"])
        extra = plan.get("optionTexts") or {}
        for option in options:
            text = extra.get(option["label"].upper())
            if text and not option["text"]:
                option["text"] = text
        group["sharedOptions"] = [dict(o) for o in options]
        for question in group.get("questions") or []:
            existing = question.get("options") or []
            if existing and not all_empty(existing):
                continue
            if existing or len(group.get("questions") or []) == 1:
                question["options"] = [dict(o) for o in options]
        set_type()
        if quoted and is_placeholder_instruction(str(group.get("instruction") or "")):
            group["instruction"] = quoted
        return f"options {labels[0]}-{labels[-1]} ({plan['textMode']}), type={qtype}"

    return None


def load_overlays() -> dict[tuple[str, str], dict]:
    out: dict[tuple[str, str], dict] = {}
    for path in OVERLAYS.glob("*.json"):
        data = load_json(path)
        exam_id = data.get("examId") or path.stem
        for gid, entry in (data.get("groups") or {}).items():
            out[(exam_id, str(gid))] = entry
    return out


def fix_short_answer(exam: dict, stats: Counter) -> bool:
    changed = False
    for section in exam.get("sections") or []:
        for group in section.get("questionGroups") or []:
            for question in group.get("questions") or []:
                if question.get("type") == "short_answer":
                    question["type"] = "completion"
                    if group.get("questionType") == "short_answer":
                        group["questionType"] = "completion"
                    stats["short_answer_retyped"] += 1
                    changed = True
    return changed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-backup", action="store_true")
    args = parser.parse_args()

    overlays = load_overlays()
    stats: Counter = Counter()
    decisions: list[dict[str, Any]] = []
    missing: list[dict[str, Any]] = []
    files_changed = 0
    texted_before_total = 0
    texted_after_total = 0
    regressions: list[str] = []

    for path in sorted(FIXTURES.glob("*.json")):
        data = load_json(path)
        exam_id = str(data.get("id") or path.stem)
        before = snapshot_texted(data)
        texted_before_total += len(before)
        touched = False
        if fix_short_answer(data, stats):
            touched = True

        for section in data.get("sections") or []:
            for group in section.get("questionGroups") or []:
                shared = group.get("sharedOptions") or []
                if not is_ah_empty(shared):
                    continue
                stats["ah_empty"] += 1
                gid = str(group.get("id") or "")
                overlay = overlays.get((exam_id, gid)) or {}
                note = str(overlay.get("note") or "")
                if classify_note(note) == "missing_scan":
                    stats["missing_scan"] += 1
                    missing.append({
                        "examId": exam_id,
                        "groupId": gid,
                        "numbers": [q.get("number") for q in group.get("questions") or []],
                        "note": note,
                    })
                    phantom = reconcile_phantom_shared(group)
                    if phantom:
                        stats["fixed"] += 1
                        stats["phantom_shared"] += 1
                        touched = True
                    decisions.append({
                        "examId": exam_id,
                        "groupId": gid,
                        "action": "skip_missing",
                        "reason": "printed pages missing from the scan",
                        "applied": phantom,
                    })
                    continue
                phantom = reconcile_phantom_shared(group)
                if phantom:
                    stats["fixed"] += 1
                    stats["phantom_shared"] += 1
                    decisions.append({
                        "examId": exam_id,
                        "groupId": gid,
                        "numbers": [q.get("number") for q in group.get("questions") or []],
                        "answers": answers_of(group),
                        "note": note[:240],
                        "action": "reconcile_shared",
                        "reason": phantom,
                        "applied": phantom,
                    })
                    touched = True
                    continue
                plan = decide(group, note, overlay.get("status"))
                rec = {
                    "examId": exam_id,
                    "groupId": gid,
                    "numbers": [q.get("number") for q in group.get("questions") or []],
                    "answers": answers_of(group),
                    "note": note[:240],
                    **{k: plan[k] for k in ("noteKind", "keyKind", "action", "type", "reason")},
                    "labels": None if not plan.get("labels") else f"{plan['labels'][0]}-{plan['labels'][-1]}",
                }
                if plan.get("action") == "skip_missing":
                    stats["missing_scan"] += 1
                    missing.append({
                        "examId": exam_id,
                        "groupId": gid,
                        "numbers": rec["numbers"],
                        "note": note,
                    })
                    decisions.append(rec)
                    continue
                if plan.get("action") == "refuse":
                    stats["refused"] += 1
                    decisions.append(rec)
                    continue
                result = apply_plan(group, plan, note)
                if result is None or result.startswith("refused"):
                    stats["refused"] += 1
                    rec["action"] = "refuse"
                    rec["reason"] = result or plan["reason"]
                    decisions.append(rec)
                    continue
                stats["fixed"] += 1
                stats[f"type:{plan['type']}"] += 1
                rec["applied"] = result
                decisions.append(rec)
                touched = True

        after = snapshot_texted(data)
        texted_after_total += len(after)
        lost = set(before) - set(after)
        if lost:
            regressions.append(f"{exam_id}: lost {len(lost)} texted options, e.g. {next(iter(lost))}")
        if not touched:
            continue
        files_changed += 1
        if args.dry_run:
            continue
        if lost:
            # Do not write a file that dropped real option text.
            continue
        if not args.no_backup:
            shutil.copy2(path, path.with_suffix(".json.bak"))
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    overlay_missing: list[dict[str, Any]] = []
    for (exam_id, gid), entry in overlays.items():
        note = str(entry.get("note") or "")
        if classify_note(note) != "missing_scan":
            continue
        overlay_missing.append({"examId": exam_id, "groupId": gid, "note": note})
    missing_record = {
        "schemaVersion": 1,
        "note": "Printed pages absent from the local PDF. Structure cannot be repaired until they are rescanned. Excluded from the remaining-work list.",
        "recordedAt": datetime.now(timezone.utc).isoformat(),
        "items": [
            {
                "examId": "cambridge-13-test-3-listening",
                "printedPages": [54, 55],
                "questionRange": [1, 16],
                "groupIds": sorted({
                    m["groupId"] for m in overlay_missing
                    if m["examId"] == "cambridge-13-test-3-listening"
                }),
                "reason": "C13 Test 3 Listening printed pages 54–55 were not scanned into the PDF, covering Test 3 Listening Questions 1–16.",
            }
        ],
        "ahEmptyGroups": missing,
        "overlayFlags": overlay_missing,
    }

    report = {
        "schemaVersion": 1,
        "dryRun": args.dry_run,
        "stats": dict(stats),
        "filesChanged": files_changed,
        "textedOptionsBefore": texted_before_total,
        "textedOptionsAfter": texted_after_total,
        "regressions": regressions,
        "nDecisions": len(decisions),
        "nMissing": len(missing),
        "nRefused": stats["refused"],
        "nFixed": stats["fixed"],
        "decisions": decisions,
    }
    if not args.dry_run:
        write_json(REPORT_PATH, report)
        write_json(MISSING_PATH, missing_record)
        docs = ROOT / "docs" / "known-missing-scans.md"
        docs.write_text(
            "# 已知扫描缺页（不计入待办）\n\n"
            "日期：2026-08-25。这些缺口不是题库结构修不好，是**原书页面根本没被扫进 PDF**。"
            "补扫之前不要再派校对工单。\n\n"
            "## C13 Test 3 Listening · 印刷页 54–55\n\n"
            "- 试卷：`cambridge-13-test-3-listening`\n"
            "- 覆盖题号：Questions 1–16\n"
            "- 组：见 `data-dev/repair/known-missing-scans.json`\n"
            "- 原因：本地 `教材/剑桥雅思真题13.pdf` 缺这两页。"
            "任何对着渲染图的抄写都会得到同一条 flag。\n",
            encoding="utf-8",
        )

    verb = "would change" if args.dry_run else "changed"
    print(f"{files_changed} exam files {verb}")
    print(f"  A-H empty groups : {stats['ah_empty']}")
    print(f"  fixed            : {stats['fixed']}")
    print(f"  refused          : {stats['refused']}")
    print(f"  missing scan     : {stats['missing_scan']}")
    print(f"  short_answer → completion : {stats['short_answer_retyped']}")
    print(f"  texted options   : {texted_before_total} → {texted_after_total}")
    if regressions:
        print("  REGRESSION: texted options disappeared")
        for line in regressions:
            print("   ", line)
    for key, value in sorted(stats.items()):
        if key.startswith("type:"):
            print(f"  {key:24s} {value}")
    refuse_reasons = Counter(d["reason"] for d in decisions if d.get("action") == "refuse")
    if refuse_reasons:
        print("  refuse reasons:")
        for reason, count in refuse_reasons.most_common():
            print(f"    {count:4d}  {reason}")
    return 1 if regressions else 0


if __name__ == "__main__":
    raise SystemExit(main())
