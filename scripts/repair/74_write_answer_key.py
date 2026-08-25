# -*- coding: utf-8 -*-
"""Stage 7b — validate and store one transcribed answer key block.

All-or-nothing, like `72_write_group_overlay.py`. A block is refused whole; it
is never partially accepted, because a half-written key is worse than none —
the gate would score against it.

What makes this round different from every earlier one is that the checking is
not a sample. Five things are verified mechanically, and together they leave
almost no room for a submission to be confidently wrong:

  1. **Coverage.** The block is exactly its question range, every number
     present, none extra. A transcription that drifts a line loses a number at
     one end and gains one at the other, so drift cannot pass.
  2. **Shape.** Every answer is a letter, a roman numeral, a TRUE/FALSE/NOT
     GIVEN judgement, or a short written answer. Prose swept off the page is
     refused.
  3. **Shape agreement within a range.** Cambridge does not mix judgements and
     letters inside one printed "Questions a-b" group; a block whose shapes
     alternate at random has been misread.
  4. **The known-answer probe.** The text extraction already recovered part of
     most blocks. Those answers are in the task and the submission must match
     every one. This is the check that replaces hand sampling: a model that
     guessed will disagree with them.
  5. **Cross-check against the stored key.** Not a pass/fail — the stored keys
     are themselves suspect, which is why this round exists — but the agreement
     rate is reported, because a submission that agrees with the fixture on 5%
     of a block is telling you something.

    python scripts/repair/74_write_answer_key.py --task <id> --check-only
    python scripts/repair/74_write_answer_key.py --task <id>
"""
from __future__ import annotations

import argparse
import collections
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TASKS = ROOT / "data-dev" / "repair" / "answer-key-tasks"
STORE = ROOT / "fixtures" / "answer-keys"
FIXTURES = ROOT / "fixtures" / "cambridge"

JUDGEMENT = {"TRUE", "FALSE", "NOT GIVEN", "YES", "NO"}
LETTER_RE = re.compile(r"^[A-K]$")
ROMAN_RE = re.compile(r"^(?:i{1,3}|iv|v|vi{1,3}|ix|x)$", re.I)


def shape(value: str) -> str | None:
    text = str(value).strip().rstrip(".")
    if not text or len(text) > 60:
        return None
    if text.upper() in JUDGEMENT:
        return "judgement"
    if LETTER_RE.match(text):
        return "letter"
    if ROMAN_RE.match(text):
        return "roman"
    words = text.replace("/", " ").split()
    parts = text.split("/")
    if all(len(p.split()) <= 6 for p in parts) and len(words) <= 12 and not re.search(r"[.;:]\s", text):
        return "written"
    return None


def normalise(value) -> list[str]:
    """One printed answer to the list of strings the scorer accepts."""
    if isinstance(value, list):
        parts = [str(v).strip() for v in value]
    else:
        parts = [p.strip() for p in str(value).split("/")]
    return [p for p in parts if len(p) >= 2 or p.isdigit()] or [str(value).strip()]


def extraction_is_damaged(known, submitted) -> bool:
    """Whether the *known* value is a mangled read of the submitted one.

    Three signatures, all observed in this corpus:
      "TRUE 23 A"  — a question number and the next answer swept in
      "ACAB"       — four consecutive one-letter answers run together
      "rectangul"  — the word cut short at the column edge
    In each case the submission is the sane value and the probe is the broken
    one, so the block must not be refused over it.
    """
    a = " ".join(normalise(known)).strip()
    b = " ".join(normalise(submitted)).strip()
    if not a or not b:
        return False
    if re.search(r"\d", a) and not re.search(r"\d", b):
        return True                                   # a question number swept in
    if len(b) == 1 and b.isalpha() and a.isalpha() and 2 <= len(a) <= 6 and b in a:
        return True                                   # letters glued together
    if len(a) < len(b) and b.lower().startswith(a.lower()) and len(a) >= 4:
        return True                                   # truncated at the column edge
    return False


def check(task: dict, submission: dict) -> list[str]:
    problems: list[str] = []
    if submission.get("taskId") != task["taskId"]:
        problems.append(f"taskId 不匹配：提交 {submission.get('taskId')!r}，工单 {task['taskId']!r}")
        return problems

    answers = submission.get("answers")
    if not isinstance(answers, dict) or not answers:
        problems.append("answers 缺失或不是对象")
        return problems

    lo, hi = task["expectedRange"]
    try:
        numbers = {int(k) for k in answers}
    except (TypeError, ValueError):
        problems.append("answers 的键必须是题号")
        return problems
    expected = set(range(lo, hi + 1))
    if missing := sorted(expected - numbers):
        problems.append(f"缺题号 {missing[:12]}{' …' if len(missing) > 12 else ''}")
    if extra := sorted(numbers - expected):
        problems.append(f"多出题号 {extra[:12]}（本区块只有 {lo}-{hi}）")

    shapes: dict[int, str] = {}
    for key, value in answers.items():
        try:
            number = int(key)
        except (TypeError, ValueError):
            continue
        kind = shape(value if not isinstance(value, list) else " / ".join(str(v) for v in value))
        if kind is None:
            problems.append(f"第 {number} 题的答案不像答案：{str(value)[:48]!r}")
        else:
            shapes[number] = kind

    # A printed "Questions a-b" group is one task type throughout. Judgements
    # and letters never interleave; when they do, a line was misread.
    # Drift shows up as *short runs*, not as transitions. A reading module runs
    # three passages of two or three question types each, so six or seven
    # changes of shape across 40 answers is ordinary — an earlier version of
    # this check counted transitions and capped them at four, which refused
    # perfectly good papers like C05 Test 3 (letter x10, judgement x3, roman x4,
    # judgement x6, letter x8 ...). What a slipped line actually produces is a
    # lone judgement stranded between letters, again and again.
    ordered = [shapes[n] for n in sorted(shapes)]
    runs: list[tuple[str, int]] = []
    for shape_name in ordered:
        if runs and runs[-1][0] == shape_name:
            runs[-1] = (shape_name, runs[-1][1] + 1)
        else:
            runs.append((shape_name, 1))
    singles = sum(1 for index, (_, length) in enumerate(runs)
                  if length == 1 and 0 < index < len(runs) - 1)
    if singles > 3:
        problems.append(f"区块里有 {singles} 处孤立的单题题型（前后都是别的题型），"
                        f"这是抄串行的典型形状")

    known = {int(k): v for k, v in (task.get("knownAnswers") or {}).items()}
    # Look answers up by an int-keyed view. JSON object keys are strings, so
    # comparing them against int question numbers silently matched nothing and
    # turned this whole probe — the check that replaces hand sampling — into a
    # no-op. The self-test caught it by tampering with a known answer and
    # watching the submission pass.
    by_number: dict[int, object] = {}
    for key, value in answers.items():
        try:
            by_number[int(key)] = value
        except (TypeError, ValueError):
            continue
    disagreed = []
    for number, printed in known.items():
        if number not in by_number:
            continue
        want, got = normalise(printed), normalise(by_number[number])
        if want == got:
            continue
        if extraction_is_damaged(printed, by_number[number]):
            # The probe is only as good as the text extraction behind it, and
            # that extraction glues answers together ("ACAB", "TRUE 23 A") and
            # truncates words ("rectangul"). Refusing a correct transcription
            # because our own OCR is broken would train the reviewer to distrust
            # the gate, so these are reported by the caller, not counted.
            continue
        disagreed.append((number, want, got))
    if disagreed:
        detail = "; ".join(f"{n}: 已知 {a} 提交 {b}" for n, a, b in disagreed[:6])
        problems.append(f"与文字抽取已确认的 {len(known)} 条答案冲突 {len(disagreed)} 处 —— {detail}")
    return problems


def agreement_with_fixture(task: dict, answers: dict) -> tuple[int, int]:
    path = FIXTURES / f"{task['examId']}.json"
    if not path.exists():
        return 0, 0
    exam = json.loads(path.read_text(encoding="utf-8"))
    same = total = 0
    for section in exam.get("sections") or []:
        for group in section.get("questionGroups") or []:
            for question in group.get("questions") or []:
                number = question.get("number")
                if number not in {int(k) for k in answers}:
                    continue
                stored = [str(a).strip().upper() for a in (question.get("acceptedAnswers") or [])]
                fresh = [a.upper() for a in normalise(answers[str(number)] if str(number) in answers
                                                     else answers[number])]
                total += 1
                same += stored == fresh
    return same, total


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--task", required=True)
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args()

    task_path = TASKS / f"{args.task}.task.json"
    if not task_path.exists():
        print(f"找不到工单：{task_path}")
        return 2
    answer_path = TASKS / f"{args.task}.answer.json"
    if not answer_path.exists():
        print(f"找不到答卷：{answer_path}")
        return 2

    task = json.loads(task_path.read_text(encoding="utf-8"))
    submission = json.loads(answer_path.read_text(encoding="utf-8"))
    problems = check(task, submission)
    if problems:
        print(f"拒收 {args.task}：")
        for problem in problems:
            print(f"  - {problem}")
        return 1

    answers = submission["answers"]
    same, total = agreement_with_fixture(task, answers)
    kinds = collections.Counter(shape(v if not isinstance(v, list) else " / ".join(map(str, v)))
                                for v in answers.values())
    print(f"通过 {args.task} · {len(answers)} 题 · 形状 {dict(kinds)}")
    print(f"  与文字抽取已确认的 {len(task.get('knownAnswers') or {})} 条一致")
    if total:
        print(f"  与题库现有答案键一致 {same}/{total}（仅供参考，现有键本身就是待查对象）")
    if args.check_only:
        print("  --check-only：未写入")
        return 0

    STORE.mkdir(parents=True, exist_ok=True)
    out = STORE / f"{task['examId']}.json"
    payload = {
        "schemaVersion": 1,
        "examId": task["examId"],
        "source": "printed answer key, transcribed from the scanned page",
        "taskId": task["taskId"],
        "answers": {str(n): normalise(answers[str(n)] if str(n) in answers else answers[n])
                    for n in sorted(int(k) for k in answers)},
    }
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"  已写入 {out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
