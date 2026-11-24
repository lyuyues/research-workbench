import json
import os
import time

from backend.badges import Badges


def test_badges_only_actionable(tmp_path):
    root, state = tmp_path / "R", tmp_path / "S"
    (state / "jobs").mkdir(parents=True)
    (root / "meetings/advisor").mkdir(parents=True)
    b = Badges(root, state)
    now = int(time.time() * 1000)
    assert b.compute(0, [], 0, {"configured": False}, now) == {}

    (state / "jobs/daily_check.json").write_text(json.dumps({"last_ok": now - 1000, "rc": 0}))
    (state / "jobs/weekly_radar.json").write_text(json.dumps({"rc": 1, "running": False}))
    (root / "meetings/advisor/2026-11-13_recap.md").write_text("<!-- status: draft -->\n# r\n")
    (root / "meetings/advisor/2026-11-06_recap.md").write_text("# reviewed\n")
    leads = [{"status": "new"}, {"status": "new"}, {"status": "dismissed"}]
    google = {"configured": True, "expires_at": now / 1000 + 3600, "error": None}
    out = b.compute(3, leads, now - 500, google, now)
    assert out["today"]["count"] == 4 and "3 question" in out["today"]["title"]  # note + 3 questions
    assert out["meetings"]["count"] == 1 and "2026-11-13" in out["meetings"]["title"]
    assert "annotations" not in out
    assert out["internships"]["count"] == 3 and "expires" in out["internships"]["title"]
    assert out["automation"] == {"count": 1, "title": "Failed: weekly_radar", "alert": True}

    b.mark_seen("today", now)
    b.mark_seen("internships", now)
    out = b.compute(0, leads, now - 500, {"configured": True, "expires_at": now / 1000 + 9 * 86400}, now)
    assert "today" not in out and "internships" not in out
    old = root / "meetings/advisor/2026-11-13_recap.md"
    os.utime(old, (time.time() - 40 * 86400,) * 2)
    assert "meetings" not in b.compute(0, [], 0, {}, now)


def test_badges_api(client):
    r = client.get("/api/badges")
    assert r.status_code == 200 and isinstance(r.json(), dict)
    assert client.post("/api/badges/seen", json={"panel": "today"}).json() == {"ok": True}
    assert client.post("/api/badges/seen", json={"panel": "nope"}).json() == {"ok": False}
