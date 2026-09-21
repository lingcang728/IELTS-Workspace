# -*- coding: utf-8 -*-
"""Stage 83 — finish the Choose-N normalisation and audit the merged groups.

Pass A — merge the two remaining split runs (c8t3r Q14-18, c9t3r Q18-22,
"Choose FIVE letters" extracted as five one-question ``per_question`` groups)
into single ``in_either_order`` groups, matching the 134 groups the earlier
passes already produced. Under ``per_question`` any valid arrangement of the
letters other than the keyed permutation scores 0, which is the P1-1 defect.

Pass B — consistency repair on existing ``in_either_order`` groups:
  * ``sharedOptions`` truncated so pool letters are unpickable (c10t4l-g21,
    c18t1l-g27, c19t4l-g13) — take the member option list that covers the pool.
  * member ``acceptedAnswers`` holding a stringified list ("['B', 'E']") —
    parse it back to real letters (c8t3l-g9).
  * group pool entries with junk suffixes ("E ()") — keep the letter.
  * ``questionType``/member ``type`` drifted off ``multi_choice`` (c5t3l-g11).
  * missing/foreign rubric — derive "Choose N letters, A-X." from the pool and
    the option labels (c5t3l-g11).
  * doubled ordinal prefixes on member prompts ("First selected letter: First
    answer: …" in c20t1l-g17) — collapse to a single prefix.

Pass C — strip a "Choose N letters" clause glued onto the *end* of another
group's rubric (c4t3l g33-37, c6t1l g31-37, c6t2l g15-17, c6t4l g26-27): the
clause belongs to the following Choose-N group, not to the completion rows.

Pass D — stamp ``repairSource.status: "flagged"`` onto groups whose overlay
entry is flagged (c6t4l-g28, c20t1l-g19/g21/g23, c5t3l-g11, c8t3r-g14), so
``verify_cambridge.py`` can report them as known-damage instead of failing the
gap ratchet. The flags themselves are written to ``fixtures/overlays/`` by a
human — this script only reads them.

Overlay entries (prompt/type/acceptedAnswers/options) win over fixture fields,
the same precedence 40_apply uses; overlays are never written here. A
``.json.bak`` is left beside every changed fixture.

    python scripts/repair/83_fix_choose_n_groups.py            # dry run
    python scripts/repair/83_fix_choose_n_groups.py --apply
"""
from __future__ import annotations

import argparse
import ast
import json
import re
import shutil
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import FIXTURES, OVERLAYS  # noqa: E402

NWORD = {"TWO": 2, "THREE": 3, "FOUR": 4, "FIVE": 5}
WORD_N = {v: k for k, v in NWORD.items()}
ORDINALS = ["First", "Second", "Third", "Fourth", "Fifth"]
ACCEPTED_STATUSES = {"approved", "corrected", "flagged"}
CHOICE_TYPES = {"single_choice", "multi_choice", "matching", "labelling"}

CHOOSE_START_RE = re.compile(r"^\s*Choose\s+(TWO|THREE|FOUR|FIVE)\s+letters?", re.I)
# A trailing clause glued onto another group's rubric (never the real rubric —
# a completion/single-choice row cannot itself be a Choose-N item).
CHOOSE_TAIL_RE = re.compile(r"\s*Choose\s+(?:TWO|THREE|FOUR|FIVE)\s+letters?[.,]?\s*[A-Z]\s*[-–—]?\s*[A-Z]?\.?\s*$", re.I)
CLAUSE_RE = re.compile(
    r"Choose\s+(?:TWO|THREE|FOUR|FIVE)\s+letters?,?\s*A\s*[-–—]\s*[A-Z]\s*\.?",
    re.I,
)
ORDINAL_PREFIX_RE = re.compile(
    r"^(?:First|Second|Third|Fourth|Fifth)\s+(?:selected\s+letter|answer)\s*:\s*",
    re.I,
)
QNUM_PREFIX_RE = re.compile(r"^Question\s+\d{1,2}\s*:\s*", re.I)
QNUM_SUFFIX_RE = re.compile(r"\s*\(Question\s+\d{1,2}\)\s*$", re.I)
TRANSCRIPT_SLICE_RE = re.compile(r"^[a-z,.;:!?)\]}\-]")
CJK_RE = re.compile(r"[一-鿿　-〿＀-￯]")
LETTER_RE = re.compile(r"^[A-Z]$")
LEADING_LETTER_JUNK_RE = re.compile(r"^([A-Z])\s*[\(\[{].*$")
PLACEHOLDER_INSTRUCTIONS = {"", "write the answer from the source question."}
SCRIPT_SOURCE = {"kind": "script",
                 "note": "83_fix_choose_n_groups: split Choose-N boxes merged into one in_either_order group"}


def choose_n_start(instruction: str) -> int | None:
    m = CHOOSE_START_RE.match(instruction or "")
    return NWORD[m.group(1).upper()] if m else None


def load_overlay(examid: str) -> tuple[dict[str, Any], dict[str, Any]]:
    path = OVERLAYS / f"{examid}.json"
    if not path.exists():
        return {}, {}
    data = json.loads(path.read_text(encoding="utf-8"))
    questions = {
        qid: entry
        for qid, entry in (data.get("questions") or {}).items()
        if (entry or {}).get("status") in ACCEPTED_STATUSES
    }
    groups = {
        gid: entry
        for gid, entry in (data.get("groups") or {}).items()
        if (entry or {}).get("status") in ACCEPTED_STATUSES
    }
    return questions, groups


def effective_question(question: dict[str, Any], overlay: dict[str, Any] | None) -> dict[str, Any]:
    q = dict(question)
    if overlay:
        for field in ("prompt", "type", "gapText", "acceptedAnswers"):
            if field in overlay:
                q[field] = overlay[field]
        if overlay.get("options"):
            q["options"] = overlay["options"]
    return q


def option_labels(options: list[dict[str, Any]] | None) -> set[str]:
    return {str(o.get("id") or o.get("label") or "").strip().upper() for o in options or []}


def letter_pool(items: list[Any]) -> list[str]:
    """Letters from an acceptedAnswers list, tolerating stringified lists."""
    pool: list[str] = []
    for item in items or []:
        text = str(item).strip()
        if text.startswith("[") and text.endswith("]"):
            try:
                inner = ast.literal_eval(text)
            except (ValueError, SyntaxError):
                inner = None
            if isinstance(inner, (list, tuple)):
                for sub in inner:
                    s = str(sub).strip().upper()
                    if LETTER_RE.fullmatch(s) and s not in pool:
                        pool.append(s)
                continue
        for part in text.split("|"):
            s = part.strip().upper()
            if LETTER_RE.fullmatch(s) and s not in pool:
                pool.append(s)
    return pool


def option_list(run: list[tuple[dict[str, Any], dict[str, Any]]],
                group_overlay: dict[str, Any] | None,
                pool: set[str] | None = None) -> list[dict[str, Any]] | None:
    """Richest option list: group overlay > member options > sharedOptions.

    When ``pool`` is given, prefer the *shortest* list that still covers every
    pool letter (a longer foreign list is worse than a complete short one),
    falling back to the longest list when nothing covers the pool.
    """
    if group_overlay and group_overlay.get("options"):
        return group_overlay["options"]
    candidates: list[list[dict[str, Any]]] = []
    for group, question in run:
        for candidate in (question.get("options"), group.get("sharedOptions")):
            if candidate:
                candidates.append(candidate)
    if not candidates:
        return None
    if pool:
        covering = [c for c in candidates if pool <= option_labels(c)]
        if covering:
            return min(covering, key=len)
    return max(candidates, key=len)


def strip_stem_prefix(prompt: str) -> str:
    text = prompt
    for _ in range(2):  # "First selected letter: First answer: …" double wrap
        text = ORDINAL_PREFIX_RE.sub("", text)
    return QNUM_PREFIX_RE.sub("", text).strip()


def junk_prompt(stripped: str) -> bool:
    if not stripped:
        return True
    if CHOOSE_START_RE.match(stripped):
        return True
    if stripped.lower().rstrip(".") in PLACEHOLDER_INSTRUCTIONS:
        return True
    return bool(TRANSCRIPT_SLICE_RE.match(stripped))


def derive_stem(stripped: list[str]) -> str | None:
    good = [s for s in stripped if not junk_prompt(s)]
    if not good:
        return None
    counts: dict[str, int] = {}
    for s in good:
        counts[s] = counts.get(s, 0) + 1
    modal = max(counts.items(), key=lambda kv: (kv[1], len(kv[0])))
    if modal[1] >= 2 or len(counts) == 1:
        return modal[0]
    prefix = good[0]
    for other in good[1:]:
        while not other.startswith(prefix):
            prefix = prefix[:-1]
            if len(prefix) < 15:
                return None
    cut = max(prefix.rfind("."), prefix.rfind("?"), prefix.rfind("!"))
    if cut < 15:
        return None
    return prefix[: cut + 1].strip()


def flagged_source(group_overlay: dict[str, Any] | None) -> dict[str, Any] | None:
    if group_overlay and group_overlay.get("status") == "flagged":
        return {"kind": "overlay", "status": "flagged",
                "reviewedAt": group_overlay.get("reviewedAt"),
                "note": group_overlay.get("note")}
    return None


def merge_run(run: list[tuple[dict[str, Any], dict[str, Any]]], n: int,
              group_overlay: dict[str, Any] | None) -> tuple[dict[str, Any] | None, str]:
    first = run[0][0]
    numbers = [int(q.get("number") or 0) for _, q in run]
    if numbers != list(range(numbers[0], numbers[0] + n)):
        return None, f"question numbers {numbers} are not consecutive"

    pool = letter_pool([item for _, q in run for item in (q.get("acceptedAnswers") or [])])
    if len(pool) != n:
        return None, f"answer pool {pool} has {len(pool)} letters, expected {n} — needs human review"

    options = option_list(run, group_overlay, set(pool))
    if not options:
        return None, "no option list on any member — shared multi-select cannot render"
    labels = option_labels(options)
    missing = [letter for letter in pool if letter not in labels]
    if missing:
        return None, f"pool letters {missing} are not among options {sorted(labels)}"

    instructions = [str(g.get("instruction") or "") for g, _ in run]
    clean = [t.strip() for t in instructions if not CJK_RE.search(t)]
    if group_overlay and group_overlay.get("instruction"):
        instruction = str(group_overlay["instruction"]).strip()
    elif clean:
        instruction = min(clean, key=len)
    else:
        clause = CLAUSE_RE.search(instructions[0])
        instruction = clause.group(0).strip().rstrip(".") + "." if clause else instructions[0].strip()

    stripped = [QNUM_SUFFIX_RE.sub("", strip_stem_prefix(str(q.get("prompt") or ""))).strip()
                for _, q in run]
    stem = derive_stem(stripped)
    if not stem:
        return None, "no usable shared stem across members — needs human review"
    use_qnum_suffix = any(QNUM_SUFFIX_RE.search(str(q.get("prompt") or "")) for _, q in run)

    merged = json.loads(json.dumps(first))
    merged["instruction"] = instruction
    merged["questionType"] = "multi_choice"
    merged["scoringPolicy"] = "in_either_order"
    merged["acceptedAnswers"] = pool
    merged["sharedOptions"] = options
    merged["repairSource"] = flagged_source(group_overlay) or dict(SCRIPT_SOURCE)

    questions = []
    for idx, (_, q) in enumerate(run):
        nq = dict(q)
        nq["type"] = "multi_choice"
        rebuilt = junk_prompt(stripped[idx]) or stripped[idx] != stem
        prompt = f"{ORDINALS[idx]} selected letter: {stem}"
        if use_qnum_suffix:
            prompt += f" (Question {numbers[idx]})"
        nq["prompt"] = prompt
        nq["options"] = options
        if rebuilt:
            rs = dict(nq.get("repairSource") or {})
            rs.update({"kind": "script",
                       "note": "83_fix_choose_n_groups: stem rebuilt from the shared either-order stem"})
            nq["repairSource"] = rs
        questions.append(nq)
    merged["questions"] = questions
    return merged, "ok"


def audit_merged_group(group: dict[str, Any], overlay_g: dict[str, Any] | None) -> tuple[dict[str, Any], list[str]]:
    """Pass B — repair consistency of an existing in_either_order group."""
    fixed = json.loads(json.dumps(group))
    changes: list[str] = []
    qs = fixed.get("questions") or []

    pool = letter_pool(fixed.get("acceptedAnswers") or [])
    if not pool:
        pool = letter_pool([item for q in qs for item in (q.get("acceptedAnswers") or [])])
    # Junk-suffixed pool entries ("E ()") → bare letter when it is a letter.
    raw_acc = [str(x).strip() for x in (fixed.get("acceptedAnswers") or [])]
    cleaned_acc: list[str] = []
    for entry in raw_acc:
        m = LEADING_LETTER_JUNK_RE.match(entry)
        cleaned_acc.append(m.group(1) if m else entry)
    if cleaned_acc != raw_acc:
        fixed["acceptedAnswers"] = cleaned_acc
        pool = letter_pool(cleaned_acc)
        changes.append(f"group acceptedAnswers cleaned → {cleaned_acc}")

    if fixed.get("questionType") != "multi_choice" and pool:
        changes.append(f"questionType {fixed.get('questionType')} → multi_choice")
        fixed["questionType"] = "multi_choice"

    for q in qs:
        if str(q.get("type") or "") in CHOICE_TYPES and q.get("type") != "multi_choice":
            q["type"] = "multi_choice"
            changes.append(f"q{q.get('number')} type → multi_choice")
        # Stringified-list member answers back to real letters.
        acc = q.get("acceptedAnswers")
        if isinstance(acc, list) and any(str(x).strip().startswith("[") for x in acc):
            letters = letter_pool(acc)
            if letters:
                q["acceptedAnswers"] = letters
                changes.append(f"q{q.get('number')} acceptedAnswers de-stringified → {letters}")

    labels = option_labels(fixed.get("sharedOptions"))
    if pool and not set(pool) <= labels:
        run = [(fixed, q) for q in qs]
        replacement = option_list(run, overlay_g, set(pool))
        if replacement and set(pool) <= option_labels(replacement):
            fixed["sharedOptions"] = replacement
            for q in qs:
                q["options"] = replacement
            changes.append(f"sharedOptions replaced with {len(replacement)}-option list covering {pool}")
        else:
            changes.append(f"POOL UNCOVERED {pool} vs labels {sorted(labels)} — needs human review")

    if pool and not choose_n_start(str(fixed.get("instruction") or "")):
        hi = max(option_labels(fixed.get("sharedOptions")) or labels or {"E"})
        fixed["instruction"] = f"Choose {WORD_N.get(len(pool), str(len(pool)))} letters, A-{hi}."
        changes.append(f"instruction rebuilt → {fixed['instruction']!r}")

    # "First selected letter: First answer: …" — a second ordinal prefix was
    # glued onto an already-merged prompt. Keep the outer one only.
    for q in qs:
        prompt = str(q.get("prompt") or "")
        outer = ORDINAL_PREFIX_RE.match(prompt)
        if not outer:
            continue
        inner = ORDINAL_PREFIX_RE.sub("", prompt)
        if ORDINAL_PREFIX_RE.match(inner):
            q["prompt"] = outer.group(0) + ORDINAL_PREFIX_RE.sub("", inner).strip()
            changes.append(f"q{q.get('number')} doubled ordinal prefix collapsed")
    return fixed, changes


def fix_exam(exam: dict[str, Any], overlay_q: dict[str, Any], overlay_g: dict[str, Any]) -> tuple[list[str], list[str]]:
    changes: list[str] = []
    skipped: list[str] = []
    for section in exam.get("sections") or []:
        groups = section.get("questionGroups") or []
        out: list[dict[str, Any]] = []
        i = 0
        while i < len(groups):
            group = groups[i]
            qs = group.get("questions") or []
            gid = str(group.get("id") or "")
            govl = overlay_g.get(gid)
            instruction = str(group.get("instruction") or "")
            n = choose_n_start(instruction)
            policy = str(group.get("scoringPolicy") or "per_question")

            # Pass D — flag stamp for human-flagged groups.
            if flagged_source(govl) and (group.get("repairSource") or {}).get("status") != "flagged":
                group["repairSource"] = flagged_source(govl)
                changes.append(f"{gid} stamped flagged (overlay note)")

            # Pass C — leaked trailing Choose clause on a non-choose group.
            if n is None and policy == "per_question" and CHOOSE_TAIL_RE.search(instruction) \
                    and all(str(q.get("type") or "") not in CHOICE_TYPES or len(qs) == 1
                            for q in qs):
                stripped = CHOOSE_TAIL_RE.sub("", instruction).strip()
                if stripped:
                    group["instruction"] = stripped
                    changes.append(f"{gid} leaked 'Choose …' clause stripped from instruction")

            if policy == "in_either_order":
                audited, achanges = audit_merged_group(group, govl)
                if achanges:
                    changes.extend(f"{gid} {c}" for c in achanges)
                    group = audited
                out.append(group)
                i += 1
                continue

            first_q = qs[0] if len(qs) == 1 else {}
            if not n or str(first_q.get("type") or "") not in CHOICE_TYPES or group.get("layoutHtml"):
                out.append(group)
                i += 1
                continue
            run = [group]
            j = i + 1
            while j < len(groups) and len(run) < n:
                nxt = groups[j]
                nqs = nxt.get("questions") or []
                if len(nqs) != 1 or str(nqs[0].get("type") or "") not in CHOICE_TYPES or nxt.get("layoutHtml"):
                    break
                prev_no = int(run[-1]["questions"][0].get("number") or 0)
                if int(nqs[0].get("number") or 0) != prev_no + 1:
                    break
                ninstr = str(nxt.get("instruction") or "")
                if not (ninstr == instruction or choose_n_start(ninstr) == n
                        or ninstr.strip().lower() in PLACEHOLDER_INSTRUCTIONS):
                    break
                run.append(nxt)
                j += 1
            if len(run) == n:
                eff = [(g, effective_question(g["questions"][0], overlay_q.get(g["questions"][0].get("id"))))
                       for g in run]
                merged, why = merge_run(eff, n, govl)
                if merged is None:
                    skipped.append(f"{gid}… Choose-{ORDINALS[n - 2]} run: {why}")
                    out.extend(run)
                else:
                    dropped = [str(g.get("id")) for g in run[1:]]
                    changes.append(f"{merged['id']} + {', '.join(dropped)} → in_either_order pool={merged.get('acceptedAnswers')}")
                    out.append(merged)
                i = j
                continue
            out.append(group)
            i += 1
        section["questionGroups"] = out
    return changes, skipped


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    total_changes = 0
    total_skipped = 0
    for path in sorted(FIXTURES.glob("cambridge-*.json")):
        if path.name.endswith(".bak"):
            continue
        exam = json.loads(path.read_text(encoding="utf-8"))
        overlay_q, overlay_g = load_overlay(str(exam.get("id") or path.stem))
        changes, skipped = fix_exam(exam, overlay_q, overlay_g)
        if not changes and not skipped:
            continue
        print(path.name)
        for line in changes:
            print("  ", line)
        for line in skipped:
            print("   SKIP", line)
        total_changes += len(changes)
        total_skipped += len(skipped)
        if changes and args.apply:
            bak = path.with_suffix(".json.bak")
            if not bak.exists():
                shutil.copy2(path, bak)
            path.write_text(json.dumps(exam, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{total_changes} change(s), {total_skipped} skipped",
          "applied" if args.apply else "(dry-run)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
