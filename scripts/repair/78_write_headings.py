# -*- coding: utf-8 -*-
"""Stage 9b — validate and store one passage's List of Headings box.

All-or-nothing, written into `fixtures/overlays/` as the group's shared options
so `40_apply.py` carries it in the same way every other human correction goes.

Five checks, and the last one is the reason this round can be trusted without
sampling:

  1. taskId matches.
  2. The box runs `i`, `ii`, `iii`, ... from the start with no gaps. Cambridge
     numbers headings consecutively; a list that jumps has lost a line.
  3. Every heading has text, none repeats, and none is just its own numeral.
  4. A heading is a phrase, not a paragraph — anything past 160 characters is
     passage text that came along by accident.
  5. **Every roman numeral the passage's answer key uses must be in the box.**
     A box ending at `vi` cannot serve a passage whose key names `viii`, so a
     short or misread list is refused rather than stored.

    python scripts/repair/78_write_headings.py --task <id> --check-only
    python scripts/repair/78_write_headings.py --task <id>
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TASKS = ROOT / "data-dev" / "repair" / "headings-tasks"
OVERLAYS = ROOT / "fixtures" / "overlays"

ROMAN = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii"]
MAX_HEADING_CHARS = 160


def normalise(value) -> list[tuple[str, str]] | None:
    """Accept an ordered list of headings, or a {numeral: heading} object."""
    if isinstance(value, list):
        return [(ROMAN[i], str(v).strip()) for i, v in enumerate(value) if i < len(ROMAN)]
    if isinstance(value, dict):
        out = []
        for key, text in value.items():
            numeral = str(key).strip().lower()
            if numeral not in ROMAN:
                return None
            out.append((numeral, str(text).strip()))
        return sorted(out, key=lambda kv: ROMAN.index(kv[0]))
    return None


def check(task: dict, submission: dict) -> list[str]:
    if submission.get("taskId") != task["taskId"]:
        return [f"taskId 不匹配：提交 {submission.get('taskId')!r}，工单 {task['taskId']!r}"]

    headings = normalise(submission.get("headings"))
    if headings is None:
        return ["headings 缺失或格式无法解析（应为有序数组，或 {罗马数字: 标题} 对象）"]
    if len(headings) < 3:
        return [f"只给了 {len(headings)} 条标题，List of Headings 从不这么短"]

    problems: list[str] = []
    numerals = [n for n, _ in headings]
    expected = ROMAN[:len(headings)]
    if numerals != expected:
        problems.append(f"标题编号是 {numerals}，剑桥连续编号，应为 {expected}")

    seen: set[str] = set()
    for numeral, text in headings:
        body = text.strip()
        if not body:
            problems.append(f"{numeral} 没有标题文字")
        elif body.lower() == numeral:
            problems.append(f"{numeral} 的文字就是它自己的编号 —— 没有真的抄页面")
        elif len(body) > MAX_HEADING_CHARS:
            problems.append(f"{numeral} 长达 {len(body)} 字，像是正文而不是小标题")
        elif body.lower() in seen:
            problems.append(f"有两条标题文字相同：{body[:44]!r}")
        else:
            seen.add(body.lower())

    used = [k for k in (task.get("romanKeysUsed") or [])]
    if missing := [k for k in used if k not in set(numerals)]:
        problems.append(f"本篇答案用到 {used}，但提交的标题表只到 "
                        f"{numerals[-1] if numerals else '—'}，缺 {missing} —— 抄漏了或抄错了篇")
    return problems


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

    headings = normalise(submission["headings"]) or []
    print(f"通过 {args.task} · {len(headings)} 条标题 · 覆盖 {len(task['questionNumbers'])} 题")
    if args.check_only:
        print("  --check-only：未写入")
        return 0

    OVERLAYS.mkdir(parents=True, exist_ok=True)
    path = OVERLAYS / f"{task['examId']}.json"
    overlay = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {
        "schemaVersion": 1, "examId": task["examId"], "questions": {}, "groups": {},
    }
    overlay.setdefault("groups", {})
    options = [{"id": n, "label": n, "text": t} for n, t in headings]
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    for record in task["groups"]:
        gid = record["groupId"]
        overlay["groups"][gid] = {
            **(overlay["groups"].get(gid) or {}),
            "status": "corrected",
            "reviewedAt": now,
            "note": f"List of Headings box read off {task['pdf']} page {task['pdfPageNumbers']}",
            "options": options,
        }
    path.write_text(json.dumps(overlay, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"  已写入 {path.relative_to(ROOT)}（{len(task['groups'])} 个组共用这张表）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
