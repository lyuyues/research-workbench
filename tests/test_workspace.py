import json
import subprocess
import time
from datetime import timedelta
from pathlib import Path

import pytest

from backend.workspace import EditConflict, Workspace, today_local

TRACKER = """# Daily Tracker

> intro

---

## {today} (Mon)

### Tasks (Claude picks + your own)
- [ ] 🔴 do the thing → [x](Alpha/a.md)
- [x] done thing

### Habits
- [x] Swim
- [ ] Asleep by 23:00-12;30

### Notes for Claude
>

### Claude reply
> line one
> line two

---

## 2026-04-08 (Wed)

### Habits
- [ ] Swim
"""

TASKS = """# Research Tasks
> Updated: 2026-11-09 (x)

## Dashboard

| Project | Phase |
| --- | --- |
| Alpha | P4 |

---

## Alpha — SOP Progress

### 🔴 Meeting items → [m.md](Alpha/m.md)
- [ ] S-MEET-1 **Paper** — write it
- [x] S-MEET-2 done
- **Ethics note**: something

### P0 Seed ✅
- [x] Idea

## Progress Log

**Nov 9 (Mon)**
- did stuff

**Oct 8 (Thu)**
- older

## Archive
- [ ] archived task
"""

DIGEST = """# Weekly Literature Digest — 2026-11-09

Intro line.

## Directly relevant

### Paper A
- [ ] read

- **Authors**: A, B
- **Venue**: JADD (2026-11-03)
- **DOI**: [DOI](https://doi.org/10.1/abc)
- **Summary**: one-line summary
- **Relation to projects**:
  - **Alpha**: close
→ [Quick summary](../reading-notes/2026-11-09-summaries.md#1-paper-a)

## Not relevant
"""

ANNOT = """# Doc

## Section X

> ⚠️ **Question for you** (2026-06-11, Claude)
> 1. Question one?
> 2. Question two?

after
"""


@pytest.fixture
def root(tmp_path: Path) -> Path:
    r = tmp_path / "Research"
    (r / "literature-radar" / "digests").mkdir(parents=True)
    (r / "projects.yaml").write_text("projects:\n  - {name: Alpha, code: S}\n  - {name: Beta, code: V}\n")
    (r / "literature-radar" / "reading-notes").mkdir()
    (r / "Alpha" / "paper" / "overleaf" / "texfiles").mkdir(parents=True)
    (r / "Alpha" / "_archive").mkdir()
    (r / "weekly_reports").mkdir()
    (r / "daily_tracker.md").write_text(TRACKER.format(today=today_local().isoformat()))
    (r / "research_tasks.md").write_text(TASKS)
    (r / "literature-radar" / "digests" / "2026-11-09-weekly.md").write_text(DIGEST)
    (r / "literature-radar" / "reading-notes" / "2026-11-09-summaries.md").write_text("# s\n")
    (r / "Alpha" / "doc.md").write_text(ANNOT)
    (r / "Alpha" / "_archive" / "old.md").write_text(ANNOT)
    tex = r / "Alpha" / "paper" / "overleaf" / "texfiles"
    (tex / "1-intro.tex").write_text("\\section{Intro}\n" + "word " * 400 + "\n% TODO hidden\n")
    (tex / "5-eval.tex").write_text("\\section{Eval}\nTODO\n")
    (r / "Alpha" / "paper" / "overleaf" / ".git").mkdir()
    (r / "Alpha" / "paper" / "overleaf" / ".git" / "config").write_text(
        '[remote "origin"]\n\turl = https://git@git.overleaf.com/0123456789abcdef01234567\n')
    now = today_local()
    (r / "time_log.jsonl").write_text("\n".join(json.dumps(x) for x in [
        {"ts": f"{now.isoformat()}T10:00:00-08:00", "project": "Alpha", "task": "a", "duration_min": 60},
        {"ts": f"{now.isoformat()}T11:00:00-08:00", "project": "Alpha", "task": "b", "duration_min": 30},
        {"ts": f"{(now - timedelta(days=30)).isoformat()}T11:00:00-08:00", "project": "old", "task": "c", "duration_min": 5},
        {"ts": "x", "type": "daily_summary"},
    ]) + "\nnot json\n")
    return r


def test_daily_today_entry(root):
    d = Workspace(root).daily()
    e = d["entries"][0]
    assert e["date"] == d["today"]
    kinds = {s["kind"]: s for s in e["sections"]}
    assert [i["checked"] for i in kinds["tasks"]["items"]] == [False, True]
    assert kinds["habits"]["items"][1]["text"] == "Asleep by 23:00-12;30"
    assert kinds["reply"]["quote"] == "line one\nline two"
    assert len(d["entries"]) == 2


def test_checkbox_toggle_and_conflict(root):
    w = Workspace(root)
    item = w.daily()["entries"][0]["sections"][0]["items"][0]
    w.set_checkbox("daily_tracker.md", item["line"], item["raw"], True)
    assert w.daily()["entries"][0]["sections"][0]["items"][0]["checked"] is True
    with pytest.raises(EditConflict):  # stale `expect`
        w.set_checkbox("daily_tracker.md", item["line"], item["raw"], False)
    text = (root / "daily_tracker.md").read_text()
    assert "- [x] 🔴 do the thing" in text and text.endswith("- [ ] Swim\n")


def test_resolve_rejects_escape(root):
    w = Workspace(root)
    for bad in ["../x.md", "/etc/passwd", "Alpha/../../x", ".git/config", "Alpha/paper/overleaf/.git/config"]:
        with pytest.raises(ValueError):
            w.resolve(bad)


def test_read_text_only_text(root):
    w = Workspace(root)
    assert "Question one" in w.read_text("Alpha/doc.md")["text"]
    (root / "x.pdf").write_bytes(b"%PDF")
    with pytest.raises(ValueError):
        w.read_text("x.pdf")


def test_tasks(root):
    t = Workspace(root).tasks()
    assert t["updated"] == "2026-11-09"
    assert t["dashboard"] == {"header": ["Project", "Phase"], "rows": [["Alpha", "P4"]]}
    g = t["groups"][0]
    assert g["title"] == "Alpha — SOP Progress"
    ms = g["milestones"][0]
    assert ms["status"] == "🔴" and ms["open"] == 1 and ms["done"] == 1
    assert ms["items"][0]["id"] == "S-MEET-1"
    assert ms["notes"] == ["**Ethics note**: something"]
    assert all("archived" not in i["text"] for g in t["groups"] for m in g["milestones"] for i in m["items"])
    log = Workspace(root).progress_log()
    assert [e["title"] for e in log] == ["Nov 9 (Mon)", "Oct 8 (Thu)"]


def test_literature(root):
    lit = Workspace(root).literature()
    assert lit["digest"] == "2026-11-09-weekly.md"
    p = lit["groups"][0]["papers"][0]
    assert p["title"] == "Paper A" and p["read"]["checked"] is False
    assert p["doi"] == "https://doi.org/10.1/abc"
    assert p["fields"]["Summary"] == "one-line summary"
    assert p["links"] == [{"label": "Quick summary", "path": "literature-radar/reading-notes/2026-11-09-summaries.md",
                           "anchor": "1-paper-a"}]
    assert lit["groups"][1]["papers"] == []
    with pytest.raises(ValueError):
        Workspace(root).literature("../../daily_tracker.md")


def test_annotations_and_reply(root):
    w = Workspace(root)
    a = w.annotations()
    assert a["pending"] == 1 and len(a["blocks"]) == 1  # _archive skipped
    b = a["blocks"][0]
    assert b["path"] == "Alpha/doc.md" and b["heading"] == "Section X" and "Question two?" in b["text"]
    w.reply_annotation(b["path"], b["end_line"], b["end_raw"], "Yes.\nSecond line")
    text = (root / "Alpha/doc.md").read_text()
    assert "> 2. Question two?\n> → the user: Yes.\n> Second line\n\nafter" in text
    assert w.annotations()["blocks"][0]["replied"] is True


def test_writing(root):
    p = Workspace(root).writing()["papers"][0]
    assert p["overleaf"] == "https://www.overleaf.com/project/0123456789abcdef01234567"
    s = {x["name"]: x for x in p["sections"]}
    assert s["1-intro.tex"]["status"] == "draft" and s["1-intro.tex"]["todos"] == 1
    assert s["5-eval.tex"]["status"] == "empty"


def test_weekly(root):
    wk = Workspace(root).weekly()
    assert wk["total_minutes"] == 90
    assert wk["by_project"] == [{"project": "Alpha", "minutes": 90}]
    assert sum(d["minutes"] for d in wk["by_day"]) == 90
    habits = {h["habit"]: h for h in wk["habits"]}
    assert habits["Swim"] == {"habit": "Swim", "done": 1, "of": 1}
    assert "Asleep by 23:00" in habits  # trailing "-12;30" note stripped


# ------------------------------------------------------------------ API


@pytest.fixture
def ws_client(settings, root):
    from dataclasses import replace
    from fastapi.testclient import TestClient
    from backend.app import create_app
    from backend.journal import Journal
    s = replace(settings, research_root=root, git_dir=root.parent / "git2")
    Journal(s.git_dir, s.research_root).ensure_repo()
    return TestClient(create_app(s)), s


def test_api_views(ws_client):
    c, _ = ws_client
    for url in ["/api/daily", "/api/tasks", "/api/portfolio", "/api/literature", "/api/annotations",
                "/api/writing", "/api/weekly"]:
        assert c.get(url).status_code == 200, url
    assert c.get("/api/file", params={"path": "../etc/passwd"}).status_code == 400
    assert c.get("/api/file", params={"path": "nope.md"}).status_code == 404
    assert c.get("/api/weekly", params={"week": "garbage"}).status_code == 400


def test_api_checkbox_edit_journal_and_log(ws_client):
    c, s = ws_client
    item = c.get("/api/daily").json()["entries"][0]["sections"][0]["items"][0]
    r = c.post("/api/edit/checkbox", json={"path": "daily_tracker.md", "line": item["line"],
                                           "expect": item["raw"], "checked": True})
    assert r.status_code == 200
    # stale line -> 409
    r = c.post("/api/edit/checkbox", json={"path": "daily_tracker.md", "line": item["line"],
                                           "expect": item["raw"], "checked": True})
    assert r.status_code == 409
    # only allow-listed files
    r = c.post("/api/edit/checkbox", json={"path": "Alpha/doc.md", "line": 1, "expect": "# Doc", "checked": True})
    assert r.status_code == 403
    for _ in range(50):  # snapshot runs in the background
        log = subprocess.run(["git", f"--git-dir={s.git_dir}", "log", "--format=%s"], capture_output=True, text=True).stdout
        if "web: tick daily_tracker.md" in log:
            break
        time.sleep(0.1)
    assert "web: tick daily_tracker.md" in log
    ops = c.get("/api/oplog").json()
    assert ops[0]["actor"] == "user" and ops[0]["action"] == "ticked"


def test_api_annotation_reply(ws_client):
    c, _ = ws_client
    b = c.get("/api/annotations").json()["blocks"][0]
    body = {"path": b["path"], "line": b["line"], "end_line": b["end_line"], "end_raw": b["end_raw"], "text": "ok"}
    # wrong header line -> 409
    assert c.post("/api/edit/annotation-reply", json=body | {"line": 1}).status_code == 409
    assert c.post("/api/edit/annotation-reply", json=body).status_code == 200
    assert c.get("/api/annotations").json()["pending"] == 0


def test_api_daily_message(ws_client):
    c, s = ws_client
    sec = next(x for x in c.get("/api/daily").json()["entries"][0]["sections"] if x["kind"] == "message")
    body = {"path": "daily_tracker.md", "line": sec["line"], "end_line": sec["last_line"], "end_raw": sec["last_raw"],
            "text": "hello Claude"}
    assert c.post("/api/edit/daily-message", json=body | {"path": "Alpha/doc.md"}).status_code == 403
    assert c.post("/api/edit/daily-message", json=body).status_code == 200
    sec = next(x for x in c.get("/api/daily").json()["entries"][0]["sections"] if x["kind"] == "message")
    assert sec["quote"] == "hello Claude"


def test_title_date():
    from datetime import date
    from backend.workspace import title_date
    today = date(2026, 11, 10)
    assert title_date("🔴 8/1 Advisor Meeting Action Items", today) == "2026-08-01"
    assert title_date("🔴 Handover (2026-10-13)", today) == "2026-10-13"
    assert title_date("O-3 🔴 x — 12/4 the advisor ask", today) == "2025-12-04"
    assert title_date("P0 Seed ✅", today) is None
    assert title_date("version 1/2/3", today) is None




def test_section_kind_english_headings():
    from backend.workspace import section_kind
    assert [section_kind(t) for t in ["Tasks", "Habits", "Notes for Claude", "Claude reply", "Misc"]] == \
        ["tasks", "habits", "message", "reply", "other"]
