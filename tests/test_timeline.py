from datetime import date, datetime

from backend.timeline import TZ, Timeline, parse

TEXT = """# Timeline

- 2026-12-16 10:00 Group meeting — my presentation (topic TBD) #group #talk

## Alpha → Journal X (2027-02-01)
- [ ] 2027-02-01 Submit
- [x] 2026-11-01 Ethics done
- [ ] 2026-11-05 Data cleaned
- [ ] 2026-11-30 Analysis

## Venues
- 2027-01-18 DIS 2027 full paper — official #venue
- 2026-13-01 bad date
- not a date line
"""


def test_parse_groups_and_progress():
    g = parse(TEXT, date(2026, 11, 10))
    assert [x["title"] for x in g] == ["Events", "Alpha → Journal X", "Venues"]
    ev, track, venues = g
    talk = ev["items"][0]
    assert (talk["date"], talk["time"], talk["title"], talk["note"], talk["tags"], talk["days"], talk["checkbox"]) == \
        ("2026-12-16", "10:00", "Group meeting", "my presentation (topic TBD)", ["group", "talk"], 36, False)
    assert track["target"] == "2027-02-01" and track["days"] == 83
    assert [i["date"] for i in track["items"]] == ["2026-11-01", "2026-11-05", "2026-11-30", "2027-02-01"]
    p = track["progress"]
    assert (p["done"], p["total"], p["due"], p["overdue"]) == (1, 4, 2, 1)
    assert p["next"]["title"] == "Data cleaned" and p["next"]["overdue"]
    assert venues["target"] is None and "progress" not in venues and len(venues["items"]) == 1


def test_view(tmp_path):
    t = Timeline(tmp_path)
    now = datetime(2026, 11, 10, 9, 0, tzinfo=TZ)
    assert t.view(now) == {"available": False, "path": "timeline.md", "today": "2026-11-10", "groups": []}
    (tmp_path / "timeline.md").write_text(TEXT)
    assert t.view(now)["available"]


def test_calendar_group():
    from datetime import date
    from datetime import datetime, timezone
    from backend.timeline import TZ, calendar_group
    local = datetime(2026, 11, 13, 15, 0, tzinfo=timezone.utc).astimezone(TZ)
    g = calendar_group([{"title": "Advisor", "start": "2026-11-13T15:00:00Z", "location": "Room 1"},
                        {"title": "Holiday", "start": "2026-11-26", "all_day": True}], date(2026, 11, 12))
    assert g["title"] == "Calendar" and g["source"] == "google"
    assert [(i["date"], i["time"], i["days"]) for i in g["items"]] == [(local.date().isoformat(), local.strftime("%H:%M"), 1), ("2026-11-26", None, 14)]
