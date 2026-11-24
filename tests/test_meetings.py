from datetime import date, datetime

import pytest

from backend.meetings import TZ, MeetingConflict, Meetings, next_meeting


def test_next_meeting():
    from datetime import timedelta
    from backend.meetings import KINDS
    tue = datetime(2026, 11, 10, 15, 0, tzinfo=TZ)
    for kind, k in KINDS.items():
        nxt = next_meeting(kind, tue)
        assert nxt.weekday() == k["weekday"] and (nxt.hour, nxt.minute) == k["time"]
        assert timedelta(0) <= nxt - tue < timedelta(days=7)
        during = nxt + timedelta(minutes=k["minutes"] // 2)
        assert next_meeting(kind, during) == nxt                      # still shows the meeting in progress
        after = nxt + timedelta(minutes=k["minutes"] + 30)
        assert next_meeting(kind, after) == nxt + timedelta(days=7)


def test_view_questions_and_items(tmp_path, monkeypatch):
    from backend import meetings as mmod
    # fixed schedule for this test (the real one is configured in KINDS): advisor Fri 07:00, group Wed 10:00
    monkeypatch.setitem(mmod.KINDS, "advisor", {**mmod.KINDS["advisor"], "weekday": 4, "time": (7, 0)})
    monkeypatch.setitem(mmod.KINDS, "group", {**mmod.KINDS["group"], "weekday": 2, "time": (10, 0)})
    r = tmp_path
    (r / "meetings/advisor").mkdir(parents=True)
    (r / "meetings/advisor/2026-11-06_slack.md").write_text("update")
    (r / "meetings/advisor/2026-11-13_slides.md").write_text("---\n# slides")
    (r / "research_tasks.md").write_text("- [x] S-MEET801-1 **Plan B** — done\n- [ ] V-MEET801-2 **Survey** pilot\n- [ ] S-1.2 other\n")
    m = Meetings(r)
    m.add_question("advisor", "  Should we   drop the survey? ", today=date(2026, 11, 10))
    m.add_question("group", "Demo order?", today=date(2026, 11, 10))
    m.add_question("advisor", "Second one", today=date(2026, 11, 10))
    text = (r / "meetings/questions.md").read_text()
    assert text.index("Should we drop the survey?") < text.index("Second one") < text.index("## Group") < text.index("Demo order?")
    v = m.view(datetime(2026, 11, 10, 15, 0, tzinfo=TZ))
    adv = v["kinds"]["advisor"]
    assert adv["next_date"] == "2026-11-13" and adv["current"]["status"] == "prepared"
    assert [(s["date"], s["status"]) for s in adv["history"]] == [("2026-11-06", "cancelled")]
    assert [q["text"] for q in v["questions"] if q["kind"] == "advisor"] == ["Should we drop the survey? _(added 2026-11-10)_", "Second one _(added 2026-11-10)_"]
    ai = v["action_items"][0]
    assert ai["date"].endswith("-08-01") and [(i["id"], i["checked"]) for i in ai["items"]] == [("S-MEET801-1", True), ("V-MEET801-2", False)]
    with pytest.raises(ValueError):
        m.add_question("advisor", "   ")


def test_notes_conflict(tmp_path):
    m = Meetings(tmp_path)
    rel = m.save_notes("advisor", "2026-11-13", "Advisor said yes", "")
    assert (tmp_path / rel).read_text().startswith("# Advisor meeting — 2026-11-13\n\nAdvisor said yes")
    with pytest.raises(MeetingConflict):
        m.save_notes("advisor", "2026-11-13", "again", "")
    cur = (tmp_path / rel).read_text()
    m.save_notes("advisor", "2026-11-13", cur + "more", cur)
    with pytest.raises(ValueError):
        m.save_notes("advisor", "../x", "a", "")


def test_api(client, settings):
    assert client.post("/api/meetings/question", json={"kind": "advisor", "text": "Q1"}).status_code == 200
    v = client.get("/api/meetings").json()
    q = v["questions"][0]
    r = client.post("/api/edit/checkbox", json={"path": "meetings/questions.md", "line": q["line"], "expect": q["raw"], "checked": True})
    assert r.status_code == 200
    assert client.get("/api/meetings").json()["questions"][0]["checked"] is True
    r = client.post("/api/meetings/notes", json={"kind": "group", "date": "2026-11-11", "text": "notes"})
    assert r.status_code == 200 and r.json()["path"] == "meetings/group/2026-11-11_notes.md"
    assert client.post("/api/meetings/notes", json={"kind": "group", "date": "2026-11-11", "text": "x"}).status_code == 409
    assert client.post("/api/meetings/question", json={"kind": "boss", "text": "x"}).status_code == 422



def test_save_slides(tmp_path):
    m = Meetings(tmp_path)
    rel = m.save_notes("group", "2026-11-11", "---\nmarp: true\n---\n# A", "", "slides")
    assert rel == "meetings/group/2026-11-11_slides.md"
    assert (tmp_path / rel).read_text(encoding="utf-8").startswith("---\nmarp")  # no heading injected
    with pytest.raises(ValueError):
        m.save_notes("group", "2026-11-11", "x", "", "other")
