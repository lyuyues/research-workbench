#!/usr/bin/env python3
"""Research job scheduler — run every minute from the research user's crontab.

Schedules are in the user's local time (UTC); the server runs UTC. A job runs when its
latest scheduled slot has not run yet and is less than CATCH_UP old (so a reboot/outage still
catches up). "Run now" requests from the Automation panel are files in <state>/requests/<job>.
State per job: <state>/<job>.json; every run is also appended to the System log (oplog).
Jobs run one at a time (flock), each with the platform's Claude token in the environment.
"""
from __future__ import annotations

import fcntl
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

TZ = ZoneInfo(os.environ.get("RP_TZ", "UTC"))
TZ_LABEL = os.environ.get("RP_TZ_LABEL", "local")  # shown after job times
HOME = Path.home()
RESEARCH = Path(os.environ.get("RP_RESEARCH_ROOT", HOME / "Research"))
STATE = Path(os.environ.get("RP_JOBS_STATE", HOME / ".local/state/research-platform/jobs"))
OPLOG = Path(os.environ.get("RP_OPLOG", HOME / ".local/state/research-platform/oplog.jsonl"))
ENV_FILE = HOME / ".config/research-platform/env"
CATCH_UP = timedelta(hours=6)
TIMEOUT = 3 * 3600

# name -> (title, schedule, command relative to Research, or absolute). schedule: ("daily", h, m) |
# ("weekly", weekday 0=Mon, h, m) | ("hourly", m)
# Add your own: "name": {"title": ..., "schedule": ("daily", 7, 0), "cmd": ["pipeline/my_job.sh"], "log": "pipeline/my_job.log"}
JOBS: dict[str, dict] = {
    "brain_import": {"title": "Brain: new Zotero highlights", "schedule": ("daily", 7, 45),
                     "cmd": [str(Path(__file__).with_name("brain_import.sh"))], "log": "pipeline/brain_import.log"},
}


def last_slot(schedule: tuple, now: datetime) -> datetime:
    """Most recent scheduled time <= now (aware, in TZ)."""
    if schedule[0] == "hourly":
        slot = now.replace(minute=schedule[1], second=0, microsecond=0)
        return slot if slot <= now else slot - timedelta(hours=1)
    if schedule[0] == "daily":
        _, h, m = schedule
        slot = now.replace(hour=h, minute=m, second=0, microsecond=0)
        return slot if slot <= now else slot - timedelta(days=1)
    _, wd, h, m = schedule
    slot = (now - timedelta(days=(now.weekday() - wd) % 7)).replace(hour=h, minute=m, second=0, microsecond=0)
    return slot if slot <= now else slot - timedelta(days=7)


def next_slot(schedule: tuple, now: datetime) -> datetime:
    step = {"hourly": timedelta(hours=1), "daily": timedelta(days=1)}.get(schedule[0], timedelta(days=7))
    return last_slot(schedule, now) + step


def describe(schedule: tuple) -> str:
    days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    if schedule[0] == "hourly":
        return f"hourly at :{schedule[1]:02d}"
    if schedule[0] == "daily":
        return f"daily {schedule[1]:02d}:{schedule[2]:02d} {TZ_LABEL}"
    return f"{days[schedule[1]]} {schedule[2]:02d}:{schedule[3]:02d} {TZ_LABEL}"


def load_state(name: str) -> dict:
    try:
        return json.loads((STATE / f"{name}.json").read_text())
    except (OSError, ValueError):
        return {}


def save_state(name: str, st: dict) -> None:
    STATE.mkdir(parents=True, exist_ok=True)
    tmp = STATE / f".{name}.json.tmp"
    tmp.write_text(json.dumps(st, ensure_ascii=False))
    tmp.replace(STATE / f"{name}.json")


def oplog(action: str, detail: str = "", **extra) -> None:
    rec = {"ts": int(time.time() * 1000), "actor": "job", "action": action}
    if detail:
        rec["detail"] = detail[:2000]
    rec.update({k: v for k, v in extra.items() if v is not None})
    OPLOG.parent.mkdir(parents=True, exist_ok=True)
    with open(OPLOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def job_env() -> dict:
    env = dict(os.environ)
    env["PATH"] = f"{HOME}/.local/bin:{HOME}/.local/node/bin:/usr/local/bin:/usr/bin:/bin"
    env["CLAUDE_BIN"] = str(HOME / ".local/bin/claude")
    env["TZ"] = "UTC"  # job logs/dates in the user's local time
    env["RADAR_PYTHON"] = str(HOME / "jobs-venv/bin/python3")
    try:
        for line in ENV_FILE.read_text().splitlines():
            if line.startswith("CLAUDE_CODE_OAUTH_TOKEN="):
                env["CLAUDE_CODE_OAUTH_TOKEN"] = line.split("=", 1)[1].strip()
    except OSError:
        pass
    return env


def run(name: str, reason: str, slot: datetime | None) -> None:
    job = JOBS[name]
    st = load_state(name)
    started = time.time()
    st.update({"running": True, "last_start": int(started * 1000), "reason": reason})
    if slot is not None:
        st["last_slot"] = slot.isoformat()
    save_state(name, st)
    oplog(f"{job['title']} started", reason, job=name)
    try:
        # via bash: Nextcloud does not carry the executable bit
        p = subprocess.run(["bash", str(RESEARCH / job["cmd"][0]), *job["cmd"][1:]], cwd=RESEARCH,
                           env=job_env(), capture_output=True, text=True, timeout=TIMEOUT)
        rc, out = p.returncode, (p.stdout + p.stderr)
    except subprocess.TimeoutExpired:
        rc, out = 124, "timed out"
    except OSError as exc:
        rc, out = 127, str(exc)
    tail = ""
    try:
        tail = "\n".join((RESEARCH / job["log"]).read_text(errors="replace").splitlines()[-15:])
    except OSError:
        pass
    if "Not logged in" in "\n".join(tail.splitlines()[-3:]):
        rc = rc or 1
    st.update({"running": False, "last_end": int(time.time() * 1000), "rc": rc,
               "output": (out or "")[-1500:], "log_tail": tail[-3000:]})
    if rc == 0:
        st["last_ok"] = st["last_end"]
    save_state(name, st)
    oplog(f"{job['title']} {'finished' if rc == 0 else 'FAILED'}",
          f"exit {rc} after {round(time.time() - started)}s" + (f" — {out.strip()[-300:]}" if rc else ""), job=name)


def main() -> int:
    STATE.mkdir(parents=True, exist_ok=True)
    lock = open(STATE / ".lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return 0  # a job is still running; next minute will look again
    now = datetime.now(TZ)
    req_dir = STATE / "requests"
    for name in JOBS:
        req = req_dir / name
        if req.exists():
            req.unlink(missing_ok=True)
            run(name, "run now (Automation panel)", None)
            continue
        slot = last_slot(JOBS[name]["schedule"], now)
        st = load_state(name)
        done = st.get("last_slot")
        if (not done or datetime.fromisoformat(done) < slot) and now - slot < CATCH_UP:
            run(name, f"scheduled {slot:%a %m-%d %H:%M} {TZ_LABEL}", slot)
    return 0


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "run":  # manual: scheduler.py run <job>
        run(sys.argv[2], "manual (command line)", None)
    else:
        sys.exit(main())
