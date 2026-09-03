# -*- coding: utf-8 -*-
"""Watch GitHub Actions runs with detailed job/step progress reporting."""
from __future__ import annotations

import json
import subprocess
import sys
import time

if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if sys.stderr and hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def fetch_run_info(run_id: str) -> dict:
    try:
        raw = subprocess.check_output(
            ["gh", "run", "view", str(run_id), "--json", "status,conclusion,name,headBranch,displayTitle,jobs"],
            text=True,
            timeout=30,
        )
        return json.loads(raw)
    except Exception as exc:
        return {"error": str(exc), "status": "unknown", "conclusion": ""}


def get_active_step(jobs: list) -> str:
    for job in jobs or []:
        if job.get("status") == "in_progress":
            job_name = job.get("name", "")
            for step in job.get("steps") or []:
                if step.get("status") == "in_progress":
                    return f"[{job_name}] {step.get('name', '')}"
            return f"[{job_name}] in progress"
    return ""


def main() -> int:
    runs = [arg for arg in sys.argv[1:] if not arg.startswith("-")]
    if not runs:
        try:
            raw = subprocess.check_output(
                ["gh", "run", "list", "--limit=2", "--json", "databaseId"],
                text=True,
                timeout=30,
            )
            data = json.loads(raw)
            runs = [str(r["databaseId"]) for r in data]
        except Exception as exc:
            print(f"Failed to auto-detect latest runs: {exc}", file=sys.stderr)
            return 1

    print(f"Watching GitHub Actions run(s): {', '.join(runs)}", flush=True)

    pending = list(runs)
    failed = False
    last_reported_state: dict[str, str] = {}

    while pending:
        still_pending = []
        for run_id in pending:
            info = fetch_run_info(run_id)
            if "error" in info:
                print(f"[{time.strftime('%X')}] Run {run_id}: check warning - {info['error']}", flush=True)
                still_pending.append(run_id)
                continue

            status = info.get("status") or "unknown"
            conclusion = info.get("conclusion") or ""
            branch = info.get("headBranch") or ""
            name = info.get("name") or ""
            active_step = get_active_step(info.get("jobs", []))

            state_desc = f"{status}:{conclusion}:{active_step}"
            if last_reported_state.get(run_id) != state_desc:
                last_reported_state[run_id] = state_desc
                step_str = f" -> {active_step}" if active_step else ""
                conc_str = f" ({conclusion})" if conclusion else ""
                print(
                    f"[{time.strftime('%X')}] Run {run_id} ({name} @ {branch}): {status}{conc_str}{step_str}",
                    flush=True,
                )

            if status != "completed":
                still_pending.append(run_id)
            else:
                if conclusion != "success":
                    failed = True
                    print(f"[{time.strftime('%X')}] Run {run_id} FAILED with conclusion: {conclusion}", flush=True)
                else:
                    print(f"[{time.strftime('%X')}] Run {run_id} SUCCEEDED", flush=True)

        pending = still_pending
        if pending:
            time.sleep(15)

    print("FAILED" if failed else "DONE", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
