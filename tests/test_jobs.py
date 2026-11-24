import json
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.automation import Automation
from jobs import scheduler as S

TZ = S.TZ


def at(*a) -> datetime:
    return datetime(*a, tzinfo=TZ)


def test_last_and_next_slot():
    assert S.last_slot(("daily", 7, 0), at(2026, 11, 9, 6, 59)) == at(2026, 11, 8, 7, 0)
    assert S.last_slot(("daily", 7, 0), at(2026, 11, 9, 7, 0)) == at(2026, 11, 9, 7, 0)
    # Mon 07:00; 2026-11-09 is a Monday
    assert S.last_slot(("weekly", 0, 7, 0), at(2026, 11, 12, 9, 0)) == at(2026, 11, 9, 7, 0)
    assert S.last_slot(("weekly", 0, 7, 0), at(2026, 11, 9, 6, 0)) == at(2026, 11, 2, 7, 0)
    assert S.next_slot(("weekly", 6, 20, 0), at(2026, 11, 9, 12, 0)) == at(2026, 11, 15, 20, 0)
    assert S.describe(("weekly", 6, 20, 0)) == "Sun 20:00 local"


@pytest.fixture
def env(tmp_path: Path, monkeypatch):
    research = tmp_path / "Research"
    (research / "pipeline").mkdir(parents=True)
    (research / "pipeline" / "ok.sh").write_text('echo "[x] done" >> pipeline/ok.log\n')
    (research / "pipeline" / "bad.sh").write_text('echo "Not logged in · Please run /login" >> pipeline/bad.log; exit 1\n')
    monkeypatch.setattr(S, "RESEARCH", research)
    monkeypatch.setattr(S, "STATE", tmp_path / "state" / "jobs")
    monkeypatch.setattr(S, "OPLOG", tmp_path / "state" / "oplog.jsonl")
    monkeypatch.setattr(S, "ENV_FILE", tmp_path / "env")
    (tmp_path / "env").write_text("CLAUDE_CODE_OAUTH_TOKEN=test-oauth-token\n")
    monkeypatch.setattr(S, "JOBS", {
        "good": {"title": "Good job", "schedule": ("daily", 7, 0), "cmd": ["pipeline/ok.sh"], "log": "pipeline/ok.log"},
        "bad": {"title": "Bad job", "schedule": ("daily", 7, 0), "cmd": ["pipeline/bad.sh"], "log": "pipeline/bad.log"},
    })
    return tmp_path


def fake_now(monkeypatch, dt: datetime):
    class D(datetime):
        @classmethod
        def now(cls, tz=None):
            return dt
    monkeypatch.setattr(S, "datetime", D)


def test_runs_due_jobs_once_and_records_state(env: Path, monkeypatch):
    fake_now(monkeypatch, at(2026, 11, 9, 8, 0))
    S.main()
    good = json.loads((env / "state/jobs/good.json").read_text())
    bad = json.loads((env / "state/jobs/bad.json").read_text())
    assert good["rc"] == 0 and good["last_ok"] and not good["running"]
    assert "[x] done" in good["log_tail"]
    assert bad["rc"] == 1 and "last_ok" not in bad
    S.main()  # same slot: nothing reruns
    assert (env / "Research/pipeline/ok.log").read_text().count("done") == 1
    log = [json.loads(l) for l in (env / "state/oplog.jsonl").read_text().splitlines()]
    assert [e["action"] for e in log] == ["Good job started", "Good job finished", "Bad job started", "Bad job FAILED"]
    assert all(e["actor"] == "job" for e in log)


def test_no_catch_up_beyond_window(env: Path, monkeypatch):
    fake_now(monkeypatch, at(2026, 11, 9, 14, 0))  # 7 h after 07:00
    S.main()
    assert not (env / "state/jobs/good.json").exists()


def test_run_now_request(env: Path, monkeypatch):
    fake_now(monkeypatch, at(2026, 11, 9, 14, 0))
    Automation(env / "Research", env / "state").request_run("good")
    S.main()
    st = json.loads((env / "state/jobs/good.json").read_text())
    assert st["rc"] == 0 and st["reason"].startswith("run now")
    assert not (env / "state/jobs/requests/good").exists()


def test_job_env_has_token(env: Path):
    e = S.job_env()
    assert e["CLAUDE_CODE_OAUTH_TOKEN"] == "test-oauth-token" and e["CLAUDE_BIN"].endswith(".local/bin/claude")


def test_automation_snapshot(env: Path, monkeypatch):
    fake_now(monkeypatch, at(2026, 11, 9, 8, 0))
    S.main()
    research = env / "Research"
    (research / "Alpha").mkdir()
    (research / "Alpha" / "notes (conflicted copy 2026-11-09).md").write_text("x")
    (research / "reading_log").mkdir()
    (research / "reading_log" / "cron.log").write_text("ok\n")
    (env / "state" / "nextcloud.json").write_text(json.dumps({"rc": 0, "last_ok": 1, "last_end": 1}))
    snap = Automation(research, env / "state").snapshot(now_ms=int(at(2026, 11, 9, 8, 1).timestamp() * 1000))
    by = {j["name"]: j for j in snap["jobs"]}
    assert by["good"]["status"] == "ok" and by["bad"]["status"] == "failed"
    assert by["good"]["next_run"] == int(at(2026, 11, 10, 7, 0).timestamp() * 1000)
    assert snap["conflicts"] == ["Alpha/notes (conflicted copy 2026-11-09).md"]
    assert snap["nextcloud"]["status"] == "stale"



