# -*- coding: utf-8 -*-
"""Watch GitHub Actions runs. Prints only DONE or FAILED."""
from __future__ import annotations

import json
import subprocess
import sys
import time

RUNS = sys.argv[1:] or ["32961444741"]


def status(run: str) -> tuple[str, str]:
    raw = subprocess.check_output(
        ["gh", "run", "view", run, "--json", "status,conclusion"],
        text=True,
    )
    data = json.loads(raw)
    return str(data.get("status") or ""), str(data.get("conclusion") or "")


def main() -> int:
    pending = list(RUNS)
    failed = False
    while pending:
        still = []
        for run in pending:
            st, conc = status(run)
            if st != "completed":
                still.append(run)
                continue
            if conc != "success":
                failed = True
        pending = still
        if pending:
            time.sleep(45)
    print("FAILED" if failed else "DONE", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
