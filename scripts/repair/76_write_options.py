# -*- coding: utf-8 -*-
"""Stage 8b — validate and store one page's worth of recovered option lists.

All-or-nothing per task, and written into `fixtures/overlays/` so `40_apply.py`
carries it into the fixtures the same way every earlier human correction went.

The check that earlier option rounds could not make, and this one can:

    **every letter the answer key names must appear among the submitted
    options.**

That was not possible before, because the keys themselves were wrong — stage
6d replaced 984 of them with the ones printed at the back of the book. Now the
key is a second, independent witness to what the page says, so a reviewer who
reads the wrong question, stops one option short, or invents a list will not
contain the key and the task is refused whole.

Six checks in all:
  1. taskId matches, and the submission answers exactly this task's questions.
  2. Two or more options per question — a "choice" of one is not a choice.
  3. Every option has non-empty text, and no two options in a question repeat.
  4. Option text is not a bare label. `{"label": "A", "text": "A"}` is how a
     map question is honestly modelled and how a lazy submission looks; this
     round contains no map questions, so it is always the latter.
  5. Labels run A, B, C... with no gaps: printed choices are never lettered
     A, C, D.
  6. The answer key letters are all present.

    python scripts/repair/76_write_options.py --task <id> --check-only
    python scripts/repair/76_write_options.py --task <id>
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TASKS = ROOT / "data-dev" / "repair" / "option-tasks"
OVERLAYS = ROOT / "fixtures" / "overlays"

MAX_OPTION_CHARS = 200


def check(task: dict, submission: dict) -> list[str]:
    problems: list[str] = []
    if submission.get("taskId") != task["taskId"]:
        return [f"taskId 不匹配：提交 {submission.get('taskId')!r}，工单 {task['taskId']!r}"]

    given = submission.get("questions")
    if not isinstance(given, dict) or not given:
        return ["questions 缺失或不是对象（应为 {题号: [选项文字…]} 或 {题号: {label: text}}）"]

    wanted = {q["number"]: q for q in task["questions"]}
    try:
        numbers = {int(k) for k in given}
    except (TypeError, ValueError):
        return ["questions 的键必须是题号"]
    if missing := sorted(set(wanted) - numbers):
        problems.append(f"缺题号 {missing}")
    if extra := sorted(numbers - set(wanted)):
        problems.append(f"多出题号 {extra}（本工单只负责 {sorted(wanted)}）")

    for key, value in given.items():
        try:
            number = int(key)
        except (TypeError, ValueError):
            continue
        spec = wanted.get(number)
        if spec is None:
            continue
        options = normalise_options(value)
        if options is None:
            problems.append(f"第 {number} 题的选项格式无法解析：{str(value)[:60]!r}")
            continue
        if len(options) < 2:
            problems.append(f"第 {number} 题只有 {len(options)} 个选项，选择题至少要两个")
            continue

        labels = [label for label, _ in options]
        expected = [chr(ord("A") + i) for i in range(len(options))]
        if labels != expected:
            problems.append(f"第 {number} 题的选项标签是 {labels}，印刷题从不跳号，应为 {expected}")

        seen: set[str] = set()
        for label, text in options:
            body = (text or "").strip()
            if not body:
                problems.append(f"第 {number} 题的选项 {label} 没有文字")
            elif body.upper() == label.upper():
                problems.append(f"第 {number} 题的选项 {label} 的文字就是它自己的字母 —— "
                                f"本轮没有地图题，这说明没有真的抄页面")
            elif len(body) > MAX_OPTION_CHARS:
                problems.append(f"第 {number} 题的选项 {label} 长达 {len(body)} 字，像是整段正文")
            elif body.lower() in seen:
                problems.append(f"第 {number} 题有两个选项文字相同：{body[:40]!r}")
            else:
                seen.add(body.lower())

        # The check the corrected answer keys bought us.
        keys = {k.upper() for k in spec.get("answerLetters") or []}
        if missing_keys := sorted(keys - {label.upper() for label in labels}):
            problems.append(f"第 {number} 题的答案是 {sorted(keys)}，但提交的选项只到 "
                            f"{labels[-1] if labels else '—'}，缺 {missing_keys} —— "
                            f"抄的多半不是这道题")
    return problems


def normalise_options(value) -> list[tuple[str, str]] | None:
    """Accept either an ordered list of texts or a {label: text} object."""
    if isinstance(value, list):
        return [(chr(ord("A") + i), str(v).strip()) for i, v in enumerate(value)]
    if isinstance(value, dict):
        try:
            return [(str(k).strip().upper(), str(v).strip())
                    for k, v in sorted(value.items(), key=lambda kv: str(kv[0]))]
        except Exception:
            return None
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--task", required=True)
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args()

    task_path = TASKS / f"{args.task}.task.json"
    answer_path = TASKS / f"{args.task}.answer.json"
    for path in (task_path, answer_path):
        if not path.exists():
            print(f"找不到 {path}")
            return 2

    task = json.loads(task_path.read_text(encoding="utf-8"))
    submission = json.loads(answer_path.read_text(encoding="utf-8"))
    problems = check(task, submission)
    if problems:
        print(f"拒收 {args.task}：")
        for problem in problems:
            print(f"  - {problem}")
        return 1

    counts = {int(k): len(normalise_options(v) or []) for k, v in submission["questions"].items()}
    print(f"通过 {args.task} · {len(counts)} 题 · 选项数 {sorted(counts.values())}")
    if args.check_only:
        print("  --check-only：未写入")
        return 0

    OVERLAYS.mkdir(parents=True, exist_ok=True)
    path = OVERLAYS / f"{task['examId']}.json"
    overlay = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {
        "schemaVersion": 1, "examId": task["examId"], "questions": {}, "groups": {},
    }
    overlay.setdefault("questions", {})
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    for spec in task["questions"]:
        number = spec["number"]
        raw = submission["questions"].get(str(number), submission["questions"].get(number))
        options = normalise_options(raw) or []
        overlay["questions"][str(number)] = {
            **(overlay["questions"].get(str(number)) or {}),
            "status": "corrected",
            "reviewedAt": now,
            "note": f"option list read off {task['pdf']} page {task['pdfPageNumbers']}",
            "options": [{"id": label, "label": label, "text": text} for label, text in options],
        }
    path.write_text(json.dumps(overlay, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"  已写入 {path.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
