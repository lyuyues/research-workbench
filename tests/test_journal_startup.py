import dataclasses
import threading
import time

from fastapi.testclient import TestClient

from backend.app import create_app
from backend.journal import Journal


def test_existing_journal_is_ready_without_baseline(settings, monkeypatch):
    def boom(self):
        raise AssertionError("baseline must not run when HEAD exists")
    monkeypatch.setattr(Journal, "ensure_baseline", boom)
    app = create_app(settings)
    assert app.state.journal_ready.is_set()


def test_fresh_journal_baselines_in_background(settings, tmp_path, monkeypatch):
    fresh = dataclasses.replace(settings, git_dir=tmp_path / "fresh-git")
    release = threading.Event()
    real = Journal.ensure_baseline

    def slow(self):
        assert release.wait(10)
        real(self)

    monkeypatch.setattr(Journal, "ensure_baseline", slow)
    t0 = time.monotonic()
    app = create_app(fresh)                      # must not block on the baseline
    assert time.monotonic() - t0 < 5
    assert not app.state.journal_ready.is_set()
    c = TestClient(app)
    with c.websocket_connect("/ws/agent") as ws:
        ws.send_json({"prompt": "hi"})
        e = ws.receive_json()
        assert e["kind"] == "error" and "journal initializing" in e["message"]
        assert c.post("/api/agent/undo", json={"commit": "a" * 40}).status_code == 503
        release.set()
        assert app.state.journal_ready.wait(10)
        ws.send_json({"prompt": "hi"})
        events = []
        while not events or events[-1]["kind"] != "changes":
            events.append(ws.receive_json())
        assert [e["kind"] for e in events[:2]] == ["started", "session"]
    assert Journal(fresh.git_dir, fresh.research_root).tracked_files() == ["projects.yaml", "research_tasks.md"]
