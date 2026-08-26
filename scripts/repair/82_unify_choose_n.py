# -*- coding: utf-8 -*-
"""Merge split Choose TWO/THREE groups into one in_either_order group.

Writes fixtures with .bak. Does not touch overlays.

    python scripts/repair/82_unify_choose_n.py --apply
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import FIXTURES  # noqa: E402

CHOOSE_RE = re.compile(r"Choose\s+(TWO|THREE)\s+letters", re.I)
PREFIX_RE = re.compile(
    r"^(First|Second|Third)\s+selected\s+letter:\s*",
    re.I,
)


def choose_n(instruction: str) -> int | None:
    m = CHOOSE_RE.search(instruction or "")
    if not m:
        return None
    return 2 if m.group(1).upper() == "TWO" else 3


def letters_of(question: dict) -> list[str]:
    raw = question.get("acceptedAnswers") or []
    out = []
    for item in raw:
        s = str(item).strip().upper()
        if re.fullmatch(r"[A-H]", s) and s not in out:
            out.append(s)
    return out


def unify_exam(exam: dict) -> list[str]:
    changes: list[str] = []
    for section in exam.get("sections") or []:
        groups = section.get("questionGroups") or []
        i = 0
        new_groups: list[dict] = []
        while i < len(groups):
            g = groups[i]
            n = choose_n(g.get("instruction") or "")
            qs = g.get("questions") or []
            if not n or len(qs) != 1:
                new_groups.append(g)
                i += 1
                continue
            chunk = [g]
            j = i + 1
            while j < len(groups) and len(chunk) < n:
                nxt = groups[j]
                n2 = choose_n(nxt.get("instruction") or "")
                nqs = nxt.get("questions") or []
                if n2 != n or len(nqs) != 1:
                    break
                if (nxt.get("instruction") or "") != (g.get("instruction") or ""):
                    break
                q0 = qs[0]
                q1 = nqs[0]
                if int(q1.get("number") or 0) != int(q0.get("number") or 0) + (j - i):
                    break
                chunk.append(nxt)
                j += 1
            if len(chunk) != n:
                new_groups.append(g)
                i += 1
                continue
            preview_pool: list[str] = []
            for part in chunk:
                for letter in letters_of(part["questions"][0]):
                    if letter not in preview_pool:
                        preview_pool.append(letter)
            if len(preview_pool) != n:
                new_groups.append(g)
                i += 1
                continue
            merged = json.loads(json.dumps(chunk[0]))
            questions = []
            pool: list[str] = []
            stem = ""
            options = None
            for idx, part in enumerate(chunk):
                q = json.loads(json.dumps(part["questions"][0]))
                prompt = PREFIX_RE.sub("", q.get("prompt") or "").strip()
                if prompt and not stem:
                    stem = prompt
                ordinal = ["First", "Second", "Third"][idx]
                q["prompt"] = f"{ordinal} selected letter: {stem or prompt}"
                q["type"] = "multi_choice"
                for letter in letters_of(q):
                    if letter not in pool:
                        pool.append(letter)
                if q.get("options") and not options:
                    options = q["options"]
                questions.append(q)
            merged["questions"] = questions
            merged["questionType"] = "multi_choice"
            merged["scoringPolicy"] = "in_either_order"
            merged["acceptedAnswers"] = pool
            if options:
                merged["sharedOptions"] = options
            new_groups.append(merged)
            dropped = [part["id"] for part in chunk[1:]]
            changes.append(
                f"{merged['id']} + {', '.join(dropped)} → in_either_order {pool}"
            )
            i = j
        section["questionGroups"] = new_groups
    return changes


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    total = 0
    for path in sorted(FIXTURES.glob("cambridge-*-listening.json")):
        if path.name.endswith(".bak"):
            continue
        exam = json.loads(path.read_text(encoding="utf-8"))
        changes = unify_exam(exam)
        if not changes:
            continue
        total += len(changes)
        print(path.name)
        for line in changes:
            print(" ", line)
        if args.apply:
            bak = path.with_suffix(path.suffix + ".bak")
            if not bak.exists():
                shutil.copy2(path, bak)
            path.write_text(json.dumps(exam, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("groups", total, "applied" if args.apply else "dry-run")


if __name__ == "__main__":
    main()
