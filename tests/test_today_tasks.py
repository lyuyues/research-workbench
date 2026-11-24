import pytest

from backend import workspace as wsmod
from backend.workspace import EditConflict, Workspace


def setup(tmp_path, monkeypatch, today="2026-11-17"):
    from datetime import date
    monkeypatch.setattr(wsmod, "today_local", lambda: date.fromisoformat(today))
    (tmp_path / "daily_tracker.md").write_text(f"""# Daily

## {today} (Tue)

### Tasks (Claude picks + your own)
- [ ] 🔴 Alpha paper writing (S-AN-7)
- [ ] (add your own here)

### Habits
- [ ] swim
""")
    (tmp_path / "research_tasks.md").write_text("""# Tasks
- [ ] S-AN-6 Pick the scoring rule — the user to decide
- [ ] S-MEET1113-1 Redo the summary table
- [ ] S-AN-7 write findings
""")
    return Workspace(tmp_path)


def test_add_and_sync(tmp_path, monkeypatch):
    ws = setup(tmp_path, monkeypatch)
    ws.add_today_task("S-MEET1113-1 Redo the summary table")
    lines = (tmp_path / "daily_tracker.md").read_text().split("\n")
    i = lines.index("- [ ] S-MEET1113-1 Redo the summary table")
    assert lines[i + 1] == "- [ ] (add your own here)"
    with pytest.raises(EditConflict):
        ws.add_today_task("S-MEET1113-1 again")
    # ticking it in Today ticks it in research_tasks.md
    out = ws.set_checkbox("daily_tracker.md", i + 1, lines[i], True)
    assert ws.sync_task_tick(out["raw"], True) == "S-MEET1113-1"
    assert "- [x] S-MEET1113-1 Redo" in (tmp_path / "research_tasks.md").read_text()
    assert ws.sync_task_tick(out["raw"].replace("[x]", "[ ]"), False) == "S-MEET1113-1"
    assert "- [ ] S-MEET1113-1 Redo" in (tmp_path / "research_tasks.md").read_text()
    # Claude's own picks with an ID only in parentheses do not tick the whole task
    assert ws.sync_task_tick("- [x] 🔴 Alpha paper writing (S-AN-7)", True) is None


def test_no_entry_for_today(tmp_path, monkeypatch):
    ws = setup(tmp_path, monkeypatch)
    monkeypatch.setattr(wsmod, "today_local", lambda: __import__("datetime").date(2026, 11, 18))
    with pytest.raises(ValueError, match="no entry for today"):
        ws.add_today_task("S-AN-6 Pick the scoring rule")


def test_api(client, settings, monkeypatch):
    setup(settings.research_root, monkeypatch)
    r = client.post("/api/today/task", json={"text": "S-AN-6 Pick the scoring rule — the user to decide"})
    assert r.status_code == 200
    assert client.post("/api/today/task", json={"text": "S-AN-6 Pick the scoring rule"}).status_code == 409


def test_remove_from_today(tmp_path, monkeypatch):
    ws = setup(tmp_path, monkeypatch)
    ws.add_today_task("S-AN-6 Pick the scoring rule")
    lines = (tmp_path / "daily_tracker.md").read_text().split("\n")
    i = lines.index("- [ ] S-AN-6 Pick the scoring rule")
    ws.remove_today_task(i + 1, lines[i])
    t = (tmp_path / "daily_tracker.md").read_text()
    assert "S-AN-6" not in t and "- [ ] S-AN-6 Pick the scoring rule" in (tmp_path / "research_tasks.md").read_text()
    lines = t.split("\n")
    h = lines.index("- [ ] swim")
    with pytest.raises(ValueError):  # habits are not today's tasks
        ws.remove_today_task(h + 1, lines[h])
    with pytest.raises(EditConflict):
        ws.remove_today_task(3, "nope")


def test_edit_notes(tmp_path, monkeypatch):
    ws = setup(tmp_path, monkeypatch)
    p = tmp_path / "daily_tracker.md"
    p.write_text(p.read_text().replace("### Habits", "### Notes for Claude\n>\n> Lip sync is dropped\n> 11/14 notes are in outlook\n\n### Habits"))
    sec = next(x for x in ws.daily()["entries"][0]["sections"] if x["kind"] == "message")
    ws.replace_message(sec["line"], sec["last_line"], sec["last_raw"], "Lip sync is dropped")
    t = p.read_text()
    assert "### Notes for Claude\n> Lip sync is dropped\n\n### Habits" in t and "outlook" not in t
    sec = next(x for x in ws.daily()["entries"][0]["sections"] if x["kind"] == "message")
    ws.replace_message(sec["line"], sec["last_line"], sec["last_raw"], "")
    assert "### Notes for Claude\n>\n\n### Habits" in p.read_text()
    with pytest.raises(EditConflict):
        ws.replace_message(sec["line"], sec["last_line"], "stale", "x")
