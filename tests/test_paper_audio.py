import dataclasses
import json
import time

from fastapi.testclient import TestClient

from backend import audiobook, paper_audio as pa
from backend.app import create_app
from backend.reading import Reading


def _setup(settings, tmp_path, monkeypatch):
    root = tmp_path / "ab"
    s = dataclasses.replace(settings, audiobook_root=root, audiobook_python="/venv/python")
    x, _ = Reading(s.research_root).add({"title": "Creative Intent as State", "url": "https://arxiv.org/abs/2611.01234"})
    calls = []

    def fake_start(root_, pid, pdf, title, *, python, claude_bin):
        calls.append((pid, pdf.name, title, python))
        pa.set_job(root_, pid, state="writing", started=time.time())

    monkeypatch.setattr(pa, "start", fake_start)
    return TestClient(create_app(s)), root, x, calls


def test_clean_script_strips_markdown():
    s = pa.clean_script("# Title\n\n**Bold** point [3].\n- item one\n1. item two\n\n\n\nend")
    assert s == "Title\n\nBold point .\nitem one\nitem two\n\nend"


def test_make_needs_pdf_then_starts_once(settings, tmp_path, monkeypatch):
    c, root, x, calls = _setup(settings, tmp_path, monkeypatch)
    pid = x["id"]
    assert c.get(f"/api/reading/paper/{pid}/audio").json() == {"state": "none"}
    assert c.post(f"/api/reading/paper/{pid}/audio").status_code == 400  # no PDF yet
    pdf = settings.research_root / x["pdf"]
    pdf.parent.mkdir(parents=True, exist_ok=True)
    pdf.write_bytes(b"%PDF-1.4")
    assert c.post(f"/api/reading/paper/{pid}/audio").json()["state"] == "writing"
    assert c.post(f"/api/reading/paper/{pid}/audio").json()["state"] == "writing"  # already running: no 2nd job
    assert calls == [(pid, pdf.name, "Creative Intent as State", "/venv/python")]
    assert c.get("/api/reading/paper/nope/audio").status_code == 404
    assert c.get(f"/api/reading/paper/{pid}/audio.mp3").status_code == 404


def test_finished_episode_is_served_and_in_feed(settings, tmp_path, monkeypatch):
    c, root, x, _ = _setup(settings, tmp_path, monkeypatch)
    pid = x["id"]
    for i, (p, title) in enumerate([("other-1", "Other"), (pid, "Creative Intent as State")]):
        tmp = tmp_path / f"t{i}.mp3"
        tmp.write_bytes(b"ID3" + b"x" * 50)
        pa.add_episode(root, p, title, tmp, "This is a paper brief on ...", 600)
    pa.set_job(root, pid, state="done")
    st = c.get(f"/api/reading/paper/{pid}/audio").json()
    assert st["state"] == "done" and st["episode"]["n"] == 2 and st["episode"]["duration"] == 600
    r = c.get(f"/api/reading/paper/{pid}/audio.mp3")
    assert r.status_code == 200 and r.headers["content-type"] == "audio/mpeg"
    assert (pa.book_dir(root) / "002.txt").read_text().startswith("This is a paper brief")
    # regenerating keeps the episode number
    tmp = tmp_path / "again.mp3"
    tmp.write_bytes(b"ID3" + b"y" * 80)
    assert pa.add_episode(root, pid, "Creative Intent as State", tmp, "v2", 610)["n"] == 2
    meta = json.loads((pa.book_dir(root) / "book.json").read_text())
    assert [ch["n"] for ch in meta["chapters"]] == [1, 2]
    xml = audiobook.feed_xml(audiobook.load_books(root), "https://h/podcast/t")
    assert "Paper briefs · 02 Creative Intent as State" in xml


def test_stale_job_reports_error(tmp_path):
    pa.set_job(tmp_path, "arxiv-2611.01234", state="speaking", started=time.time() - pa.STALE - 5)
    st = pa.status(tmp_path, "arxiv-2611.01234")
    assert st["state"] == "error" and "stopped" in st["error"]
    assert not pa.running(tmp_path, "arxiv-2611.01234")
