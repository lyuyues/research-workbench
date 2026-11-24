"""Automation panel: server jobs (jobs/scheduler.py), Nextcloud sync, conflict copies, Mac-side jobs."""
from __future__ import annotations

import json
import os
import time
from datetime import datetime
from pathlib import Path

from jobs import scheduler

DAY_MS = 86_400_000
CONFLICT_MARKERS = ("(conflicted copy", "(conflict)", "_conflict-")
SKIP_DIRS = {".git", "node_modules", ".venv", "__pycache__"}
MAC_JOBS: list[dict] = []  # jobs that run on another machine and only leave a log in the Research folder


def _read_json(p: Path) -> dict:
    try:
        d = json.loads(p.read_text())
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


class Automation:
    def __init__(self, research_root: Path, state_dir: Path):
        self.root = Path(research_root)
        self.jobs_dir = Path(state_dir) / "jobs"
        self.nc_state = Path(state_dir) / "nextcloud.json"
        self._conflicts: tuple[float, list[str]] = (0.0, [])

    def conflicts(self, max_age_s: int = 600) -> list[str]:
        ts, found = self._conflicts
        if time.time() - ts < max_age_s:
            return found
        found = []
        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
            for f in filenames:
                if any(m in f for m in CONFLICT_MARKERS):
                    found.append(str(Path(dirpath, f).relative_to(self.root)))
                    if len(found) >= 50:
                        break
        self._conflicts = (time.time(), sorted(found))
        return self._conflicts[1]

    def snapshot(self, now_ms: int | None = None) -> dict:
        now_ms = now_ms or int(time.time() * 1000)
        now = datetime.fromtimestamp(now_ms / 1000, scheduler.TZ)
        jobs = []
        for name, job in scheduler.JOBS.items():
            st = _read_json(self.jobs_dir / f"{name}.json")
            period = DAY_MS if job["schedule"][0] == "daily" else 7 * DAY_MS
            last_ok = st.get("last_ok")
            stale = last_ok is None or now_ms - last_ok > period + DAY_MS
            jobs.append({
                "name": name, "title": job["title"], "schedule": scheduler.describe(job["schedule"]),
                "next_run": int(scheduler.next_slot(job["schedule"], now).timestamp() * 1000),
                "running": bool(st.get("running")), "last_start": st.get("last_start"), "last_end": st.get("last_end"),
                "rc": st.get("rc"), "last_ok": last_ok, "reason": st.get("reason"),
                "log_tail": st.get("log_tail", ""), "output": st.get("output", ""),
                "requested": (self.jobs_dir / "requests" / name).exists(),
                "status": "running" if st.get("running") else "failed" if st.get("rc") not in (None, 0)
                else "never" if last_ok is None else "stale" if stale else "ok",
            })
        nc = _read_json(self.nc_state)
        nc_status = "never" if not nc else "failed" if nc.get("rc") else \
            "stale" if now_ms - (nc.get("last_ok") or 0) > 30 * 60_000 else "ok"
        mac = []
        for j in MAC_JOBS:
            p = self.root / j["log"]
            try:
                mtime = int(p.stat().st_mtime * 1000)
            except OSError:
                mtime = None
            tail = ""
            try:
                tail = "\n".join(p.read_text(errors="replace").splitlines()[-8:])
            except OSError:
                pass
            mac.append({"title": j["title"], "schedule": j["schedule"], "last_activity": mtime, "log_tail": tail[-1500:],
                        "status": "never" if mtime is None else
                        "stale" if now_ms - mtime > j["max_age_h"] * 3_600_000 else "ok"})
        return {"jobs": jobs, "nextcloud": nc | {"status": nc_status}, "conflicts": self.conflicts(), "mac_jobs": mac}

    def request_run(self, name: str) -> None:
        if name not in scheduler.JOBS:
            raise KeyError(name)
        req = self.jobs_dir / "requests"
        req.mkdir(parents=True, exist_ok=True)
        (req / name).touch()
