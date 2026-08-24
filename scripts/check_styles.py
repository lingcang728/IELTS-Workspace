# -*- coding: utf-8 -*-
"""Style gate: keep the two visual domains apart and colour inside the tokens.

Three rules, each of which has already been broken once in this codebase:

  1. Only `tokens.css` may contain a literal colour. Everything else reads
     `var(--token)`. A hex in a rule file is how light and dark drift apart --
     the palette this replaced had 180 of them.

  2. `exam.css` may only read `--exam-*` tokens. The exam runtime is a fixed
     light official surface; a stray `var(--blue)` there is exactly how it
     followed the workspace into dark mode before.

  3. Nothing outside `exam.css` may read an `--exam-*` token, and no `.tsx`
     may carry a literal colour in a `style=` prop.

    python scripts/check_styles.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STYLES = ROOT / "src" / "styles"
TOKENS = STYLES / "tokens.css"

COLOUR_RE = re.compile(r"#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(")
VAR_RE = re.compile(r"var\(\s*(--[a-z0-9-]+)")
DECL_RE = re.compile(r"(--[a-z0-9-]+)\s*:")
# `color-scheme`, `accent-color` and friends take keywords, not colours; the
# regex above never matches those, so no exemption list is needed here.


def strip_comments(text: str) -> str:
    return re.sub(r"/\*.*?\*/", "", text, flags=re.S)


def main() -> int:
    failures: list[str] = []

    if not TOKENS.exists():
        print(f"missing {TOKENS}", file=sys.stderr)
        return 2
    token_text = strip_comments(TOKENS.read_text(encoding="utf-8"))
    declared = set(DECL_RE.findall(token_text))

    for path in sorted(STYLES.glob("*.css")):
        text = strip_comments(path.read_text(encoding="utf-8"))
        if path != TOKENS:
            for line_no, line in enumerate(text.splitlines(), 1):
                if COLOUR_RE.search(line):
                    failures.append(f"{path.name}:{line_no}: literal colour — use a token from "
                                    f"tokens.css instead: {line.strip()[:90]}")
        used = set(VAR_RE.findall(text))
        # A rule file may define its own local variable — `.quote-card.marker-2
        # { --quote-pen: var(--marker-2) }` — to switch a whole component on one
        # class. That is not a missing token, so long as the file declares it.
        local = set(DECL_RE.findall(text))
        missing = sorted(u for u in used
                         if u not in declared and u not in local and u != "--font-scale")
        for token in missing:
            failures.append(f"{path.name}: reads {token}, which tokens.css does not declare")
        if path.name == "exam.css":
            for token in sorted(used):
                if not token.startswith("--exam-") and token != "--font-scale":
                    failures.append(f"exam.css: reads {token}. The exam runtime is a separate "
                                    f"visual domain and may only read --exam-* tokens.")
        else:
            for token in sorted(used):
                if token.startswith("--exam-"):
                    failures.append(f"{path.name}: reads {token}. Exam tokens belong to "
                                    f"exam.css only.")

    for path in sorted((ROOT / "src").rglob("*.tsx")):
        for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if "style=" in line or "stopColor" in line or "stroke=" in line or "fill=" in line:
                if COLOUR_RE.search(line):
                    rel = path.relative_to(ROOT).as_posix()
                    failures.append(f"{rel}:{line_no}: literal colour in markup — use "
                                    f"var(--token): {line.strip()[:90]}")

    if failures:
        for failure in failures:
            print(f"FAIL {failure}", file=sys.stderr)
        print(f"\n{len(failures)} style violation(s)", file=sys.stderr)
        return 1
    print(f"styles ok: {len(declared)} tokens declared, no literal colours outside tokens.css, "
          f"exam domain sealed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
