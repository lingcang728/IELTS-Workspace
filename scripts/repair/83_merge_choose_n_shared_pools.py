# -*- coding: utf-8 -*-
"""Merge split "Choose TWO/THREE letters" groups into in_either_order groups.

Stage 82 did this for listening fixtures but only where consecutive
single-question groups shared a byte-identical instruction and the pool size
matched. The remaining cases (mostly reading) were driven by hand here: each
chunk is an explicit list of consecutive question numbers whose groups each
hold the shared answer pool, verified against the printed prompts.

Two adjacent encodings are fixed:

* N consecutive single-question groups, each carrying the whole shared
  acceptedAnswers pool (or one letter of it) -> one in_either_order group with
  the pool at group level. Under the old encoding the scorer treated the pool
  as per-question alternatives: picking one letter on both questions scored 2,
  and picking two letters inside one question's checkboxes joined to "b|c"
  which never matched.
* A lone "Which TWO ..." question carrying the pair as acceptedAnswers gets the
  joined-token form ["D|F"], matching the existing single-slot multi-select
  convention (see scoring.rs multi_choice_array_order_independent).

Writes fixtures with .json.bak beside each changed file. Does not touch
overlays. Idempotent: merged groups are in_either_order and skipped on rerun.

    python scripts/repair/83_merge_choose_n_shared_pools.py --apply
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import FIXTURES  # noqa: E402

# exam_id -> list of chunks; each chunk is consecutive question numbers that
# belong to one printed "Choose N letters" item.
MERGE_PLAN: dict[str, list[list[int]]] = {
    "cambridge-4-test-2-reading": [[33, 34, 35]],
    "cambridge-4-test-4-reading": [[20, 21], [22, 23]],
    "cambridge-5-test-1-reading": [[1, 2, 3]],
    "cambridge-5-test-2-reading": [[9, 10]],
    "cambridge-6-test-2-listening": [[18, 19, 20]],
    "cambridge-6-test-4-listening": [[28, 29, 30]],
    "cambridge-6-test-4-reading": [[25, 26]],
    "cambridge-9-test-2-reading": [[11, 12]],
    "cambridge-11-test-2-reading": [[25, 26]],
    "cambridge-12-test-2-reading": [[10, 11], [12, 13]],
    "cambridge-14-test-1-reading": [[19, 20], [21, 22]],
    "cambridge-14-test-3-reading": [[21, 22]],
    "cambridge-14-test-4-reading": [[23, 24], [25, 26]],
    "cambridge-15-test-1-reading": [[23, 24], [25, 26]],
    "cambridge-16-test-1-reading": [[25, 26]],
    "cambridge-16-test-3-reading": [[23, 24], [25, 26]],
    "cambridge-17-test-1-reading": [[23, 24], [25, 26]],
    "cambridge-17-test-3-reading": [[21, 22]],
    "cambridge-17-test-4-reading": [[23, 24], [25, 26]],
    "cambridge-18-test-4-reading": [[10, 11], [12, 13]],
    "cambridge-19-test-1-reading": [[20, 21], [22, 23]],
    "cambridge-19-test-2-reading": [[23, 24], [25, 26]],
    "cambridge-20-test-2-reading": [[23, 24], [25, 26]],
    "cambridge-20-test-3-reading": [[20, 21], [22, 23]],
    "cambridge-21-test-2-reading": [[20, 21]],
}

# instruction overrides for chunks whose surviving group instruction is junk
INSTRUCTION_FIX = {
    ("cambridge-6-test-4-listening", 28): "Choose THREE letters, A-G.",
}

# lone "Which TWO ..." single-slot questions: acceptedAnswers -> joined token
JOINED_ANSWERS = {
    ("cambridge-4-test-3-listening", 38): "D|F",
    ("cambridge-4-test-3-listening", 40): "A|C",
}

ORDINALS = ["First", "Second", "Third", "Fourth", "Fifth"]
CHOOSE_RE = re.compile(r"Choose\s+(TWO|THREE|FOUR)\s+letters", re.I)
ORDINAL_PREFIX_RE = re.compile(
    r"^(?:First|Second|Third|Fourth|Fifth)\s+(?:answer|selected letter):\s*", re.I
)
QNUM_PREFIX_RE = re.compile(r"^Question\s+\d+\s*[:.]\s*", re.I)
QNUM_SUFFIX_RE = re.compile(r"\s*\(Question\s+\d+\)\s*$", re.I)
CJK_RE = re.compile(r"[　-鿿＀-￯]")
JUNK_PROMPT_RE = re.compile(
    r"write the answer from the source question|in any order|choose\s+(two|three|four)\s+letters",
    re.I,
)


def clean_stem(prompt: str) -> str:
    text = ORDINAL_PREFIX_RE.sub("", prompt or "")
    text = QNUM_PREFIX_RE.sub("", text)
    text = QNUM_SUFFIX_RE.sub("", text)
    return text.strip()


def is_junk_prompt(prompt: str, instruction: str) -> bool:
    text = clean_stem(prompt)
    if not text:
        return True
    if JUNK_PROMPT_RE.search(text):
        return True
    if CJK_RE.search(text):
        return True
    return text == (instruction or "").strip()


def letters_of(question: dict) -> list[str]:
    out: list[str] = []
    for item in question.get("acceptedAnswers") or []:
        s = str(item).strip().upper()
        if re.fullmatch(r"[A-H]", s) and s not in out:
            out.append(s)
    return out


def best_options(chunk: list[dict]) -> list[dict]:
    """The fullest option list across sharedOptions and per-question options."""
    best: list[dict] = []
    for group in chunk:
        for candidate in [group.get("sharedOptions"), *(q.get("options") for q in group["questions"])]:
            if isinstance(candidate, list) and len(candidate) > len(best):
                best = candidate
    return best


def merge_chunk(chunk: list[dict], chunk_nums: list[int], exam_id: str) -> tuple[dict, str]:
    """Build one in_either_order group from consecutive single-question groups."""
    questions = [g["questions"][0] for g in chunk]
    nums = [q.get("number") for q in questions]
    assert nums == chunk_nums, f"{exam_id}: chunk questions {nums} != plan {chunk_nums}"
    assert nums == list(range(nums[0], nums[0] + len(nums))), f"{exam_id}: {nums} not consecutive"

    pool: list[str] = []
    for q in questions:
        for letter in letters_of(q):
            if letter not in pool:
                pool.append(letter)
    pool.sort()
    assert len(pool) == len(chunk), (
        f"{exam_id} q{nums}: pool {pool} size != chunk size {len(chunk)}"
    )

    instruction = INSTRUCTION_FIX.get((exam_id, nums[0])) or (chunk[0].get("instruction") or "")
    stems = [
        clean_stem(str(q.get("prompt") or ""))
        for q, g in zip(questions, chunk)
        if not is_junk_prompt(str(q.get("prompt") or ""), str(g.get("instruction") or ""))
    ]
    stem = Counter(stems).most_common(1)[0][0] if stems else ""

    options = best_options(chunk)
    option_ids = {str(o.get("id") or o.get("label") or "").strip().upper() for o in options}
    missing = [letter for letter in pool if letter not in option_ids]
    assert not missing, f"{exam_id} q{nums}: pool letters {missing} not in options {sorted(option_ids)}"

    merged = json.loads(json.dumps(chunk[0]))
    merged["instruction"] = instruction
    merged["questionType"] = "multi_choice"
    merged["scoringPolicy"] = "in_either_order"
    merged["acceptedAnswers"] = pool
    if options:
        merged["sharedOptions"] = options

    new_questions = []
    for idx, q in enumerate(questions):
        nq = json.loads(json.dumps(q))
        nq["type"] = "multi_choice"
        if options:
            nq["options"] = options
        nq["prompt"] = f"{ORDINALS[idx]} selected letter: {stem}" if stem else f"{ORDINALS[idx]} selected letter"
        # Convention from the stage-82 listening merges: the slot keeps its
        # canonical letter even though scoring consumes the group pool —
        # verify_cambridge counts a question with no acceptedAnswers as
        # damaged, and Results shows it as that slot's key.
        nq["acceptedAnswers"] = [pool[idx]]
        new_questions.append(nq)
    merged["questions"] = new_questions
    return merged, f"{merged['id']} ← q{nums} pool {pool}"


def heal_merged(exam: dict) -> list[str]:
    """Backfill per-question slot letters on already-merged in_either_order
    multi_choice groups whose questions lost acceptedAnswers in an earlier
    run. Idempotent."""
    changes: list[str] = []
    for section in exam.get("sections") or []:
        for group in section.get("questionGroups") or []:
            if group.get("scoringPolicy") != "in_either_order":
                continue
            if group.get("questionType") != "multi_choice":
                continue
            pool = [str(x) for x in group.get("acceptedAnswers") or []]
            questions = group.get("questions") or []
            if len(pool) != len(questions) or not pool:
                continue
            for idx, q in enumerate(questions):
                aa = [str(x).strip() for x in q.get("acceptedAnswers") or [] if str(x).strip()]
                if not aa:
                    q["acceptedAnswers"] = [pool[idx]]
                    changes.append(
                        f"{group.get('id')} q{q.get('number')} ← slot letter {pool[idx]}"
                    )
    return changes


def apply_merges(exam_id: str, exam: dict) -> list[str]:
    changes: list[str] = []
    for section in exam.get("sections") or []:
        groups = section.get("questionGroups") or []
        plans = MERGE_PLAN.get(exam_id) or []
        for chunk_nums in plans:
            member_indexes = []
            for idx, g in enumerate(groups):
                qs = g.get("questions") or []
                if len(qs) == 1 and qs[0].get("number") in chunk_nums:
                    member_indexes.append(idx)
            if not member_indexes:
                continue
            assert len(member_indexes) == len(chunk_nums), (
                f"{exam_id}: found {[groups[i]['questions'][0].get('number') for i in member_indexes]}"
                f" for plan {chunk_nums}"
            )
            assert member_indexes == list(range(member_indexes[0], member_indexes[0] + len(member_indexes))), (
                f"{exam_id}: chunk groups not adjacent for {chunk_nums}"
            )
            for i in member_indexes:
                g = groups[i]
                assert (g.get("scoringPolicy") or "per_question") != "in_either_order"
                q = g["questions"][0]
                assert q.get("type") in ("multi_choice", "single_choice"), (
                    f"{exam_id} q{q.get('number')}: unexpected type {q.get('type')}"
                )
            assert any(CHOOSE_RE.search(str(groups[i].get("instruction") or "")) for i in member_indexes), (
                f"{exam_id}: no 'Choose N letters' instruction in {chunk_nums}"
            )
            merged, note = merge_chunk([groups[i] for i in member_indexes], chunk_nums, exam_id)
            groups[member_indexes[0]] = merged
            for i in reversed(member_indexes[1:]):
                del groups[i]
            changes.append(note)
    return changes


def apply_joined(exam_id: str, exam: dict) -> list[str]:
    changes = []
    for (eid, number), token in JOINED_ANSWERS.items():
        if eid != exam_id:
            continue
        hit = None
        for section in exam.get("sections") or []:
            for g in section.get("questionGroups") or []:
                for q in g.get("questions") or []:
                    if q.get("number") == number:
                        hit = q
        assert hit is not None, f"{exam_id}: q{number} not found"
        current = [str(a).strip().upper() for a in hit.get("acceptedAnswers") or []]
        if current == [token]:
            continue  # already joined on a previous run
        assert sorted(current) == sorted(token.split("|")), (
            f"{exam_id} q{number}: acceptedAnswers {current} != {token}"
        )
        hit["acceptedAnswers"] = [token]
        changes.append(f"q{number} acceptedAnswers → [{token}]")
    return changes


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="write fixtures (default: dry-run)")
    args = parser.parse_args()

    plan_ids = set(MERGE_PLAN) | {eid for eid, _ in JOINED_ANSWERS}
    total = 0
    for exam_id in sorted(plan_ids):
        path = FIXTURES / f"{exam_id}.json"
        if not path.exists():
            print(f"MISSING {exam_id}", file=sys.stderr)
            continue
        exam = json.loads(path.read_text(encoding="utf-8"))
        changes = apply_merges(exam_id, exam) + apply_joined(exam_id, exam) + heal_merged(exam)
        if not changes:
            continue
        total += len(changes)
        print(path.name)
        for line in changes:
            print("  ", line)
        if args.apply:
            bak = path.with_suffix(path.suffix + ".bak")
            if not bak.exists():
                shutil.copy2(path, bak)
            digest = hashlib.sha1("\n".join(changes).encode("utf-8")).hexdigest()[:8]
            exam["contentRevision"] = f"repair-{len(changes):04d}-{digest}"
            path.write_text(json.dumps(exam, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("-" * 50)
    print("changes", total, "applied" if args.apply else "dry-run")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
