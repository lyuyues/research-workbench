def run(client, payload):
    with client.websocket_connect("/ws/agent") as ws:
        ws.send_json(payload)
        events = []
        while True:
            e = ws.receive_json()
            events.append(e)
            if e["kind"] == "changes":
                return events


def test_agent_roundtrip_with_context(client):
    events = run(client, {"prompt": "hi", "context": {"panel": "today"}})
    assert [e["kind"] for e in events[:2]] == ["started", "session"]
    assert any(e["kind"] == "text" and "[Current panel: today]" in e["text"] for e in events)
    assert events[-1] == {"kind": "changes", "commit": None, "files": []}


def test_agent_write_is_journaled_and_undoable(client, settings):
    events = run(client, {"prompt": "WRITE please"})
    changes = events[-1]
    assert changes["files"] == ["note.md"]
    assert (settings.research_root / "note.md").exists()
    r = client.post("/api/agent/undo", json={"commit": changes["commit"]})
    assert r.status_code == 200
    assert not (settings.research_root / "note.md").exists()


def test_pre_snapshot_keeps_user_edits_out_of_agent_commit(client, settings):
    (settings.research_root / "research_tasks.md").write_text("# tasks\n- [x] done\n")
    events = run(client, {"prompt": "WRITE"})
    assert events[-1]["files"] == ["note.md"]


# --- review fixes -----------------------------------------------------------
import dataclasses
import time

from fastapi.testclient import TestClient

from backend.app import create_app
from backend.journal import Journal


def until(ws, kind):
    events = []
    while True:
        e = ws.receive_json()
        events.append(e)
        if e["kind"] == kind:
            return events


def test_missing_binary_gives_error_then_changes(settings):
    c = TestClient(create_app(dataclasses.replace(settings, claude_bin="/nonexistent/claude")))
    events = run(c, {"prompt": "hi"})
    assert events[0] == {"kind": "started"}
    assert events[1]["kind"] == "error"
    assert events[-1] == {"kind": "changes", "commit": None, "files": []}


def test_timeout_gives_error_then_changes(settings):
    c = TestClient(create_app(dataclasses.replace(settings, agent_timeout=1)))
    events = run(c, {"prompt": "SLEEP"})
    assert any(e["kind"] == "error" and "timed out" in e["message"] for e in events)
    assert events[-1]["kind"] == "changes"


def test_cancel_kills_current_run(client):
    t0 = time.monotonic()
    with client.websocket_connect("/ws/agent") as ws:
        ws.send_json({"type": "prompt", "prompt": "SLEEP"})
        until(ws, "session")
        ws.send_json({"type": "cancel"})
        events = until(ws, "changes")
    assert time.monotonic() - t0 < 10
    assert {"kind": "error", "message": "cancelled"} in events


def test_malformed_messages_keep_socket_open(client):
    with client.websocket_connect("/ws/agent") as ws:
        ws.send_text("not json")
        assert ws.receive_json()["kind"] == "error"
        for bad in [{"prompt": 5}, {"type": "nope"}, {}, [1], {"prompt": "x", "session_id": "--evil"}]:
            ws.send_json(bad)
            assert ws.receive_json()["kind"] == "error"
        ws.send_json({"prompt": "hi"})
        assert until(ws, "changes")[-1]["kind"] == "changes"


def test_disconnect_mid_run_still_completes_and_journals(settings):
    with TestClient(create_app(settings)) as c:
        with c.websocket_connect("/ws/agent") as ws:
            ws.send_json({"prompt": "SLEEPWRITE"})
            until(ws, "session")
        j = Journal(settings.git_dir, settings.research_root)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            log = j._git("log", "--format=%s")
            if any(line.startswith("agent:") for line in log.splitlines()):
                break
            time.sleep(0.2)
        head = j._git("log", "-1", "--format=%s")
        assert head.startswith("agent: SLEEPWRITE")
        assert j.changed_files("HEAD") == ["note.md"]


def test_undo_while_running_is_409(client):
    with client.websocket_connect("/ws/agent") as ws:
        ws.send_json({"prompt": "SLEEP"})
        until(ws, "session")
        r = client.post("/api/agent/undo", json={"commit": "a" * 40})
        assert r.status_code == 409
        ws.send_json({"type": "cancel"})
        until(ws, "changes")


def test_undo_bad_or_non_agent_commit_is_400(client, settings):
    assert client.post("/api/agent/undo", json={"commit": "--abort"}).status_code == 400
    j = Journal(settings.git_dir, settings.research_root)
    baseline = j._git("rev-parse", "HEAD")
    assert client.post("/api/agent/undo", json={"commit": baseline}).status_code == 400


def test_undo_conflict_is_409(client, settings):
    events = run(client, {"prompt": "WRITE"})
    (settings.research_root / "note.md").write_text("user changed it\n")
    r = client.post("/api/agent/undo", json={"commit": events[-1]["commit"]})
    assert r.status_code == 409
    assert (settings.research_root / "note.md").read_text() == "user changed it\n"


# --- review round 2 ---------------------------------------------------------
def test_cancel_right_after_prompt_ends_quickly(client):
    t0 = time.monotonic()
    with client.websocket_connect("/ws/agent") as ws:
        ws.send_json({"prompt": "SLEEP"})
        ws.send_json({"type": "cancel"})
        events = until(ws, "changes")
    assert time.monotonic() - t0 < 10
    assert {"kind": "error", "message": "cancelled"} in events


def test_other_socket_can_cancel_orphaned_run(settings):
    with TestClient(create_app(settings)) as c:
        with c.websocket_connect("/ws/agent") as a:
            a.send_json({"prompt": "SLEEP"})
            until(a, "session")
        t0 = time.monotonic()
        with c.websocket_connect("/ws/agent") as b:
            b.send_json({"type": "cancel"})
            deadline = time.monotonic() + 10
            while True:  # wait until the orphaned run has released the lock
                b.send_json({"prompt": "hi"})
                e = b.receive_json()
                if e["kind"] == "started":
                    break
                assert e["kind"] == "error" and time.monotonic() < deadline
                time.sleep(0.2)
            assert until(b, "changes")[-1]["kind"] == "changes"
        assert time.monotonic() - t0 < 10


def test_failure_starting_run_releases_lock(client, monkeypatch):
    import backend.app as app_mod
    real = app_mod.AgentRun
    calls = []

    def flaky(*a, **kw):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("boom")
        return real(*a, **kw)

    monkeypatch.setattr(app_mod, "AgentRun", flaky)
    with client.websocket_connect("/ws/agent") as ws:
        ws.send_json({"prompt": "hi"})
        e = ws.receive_json()
        assert e["kind"] == "error" and "boom" in e["message"]
        ws.send_json({"prompt": "hi"})
        assert until(ws, "changes")[-1]["kind"] == "changes"


def test_double_undo_is_400(client):
    sha = run(client, {"prompt": "WRITE"})[-1]["commit"]
    assert client.post("/api/agent/undo", json={"commit": sha}).status_code == 200
    r = client.post("/api/agent/undo", json={"commit": sha})
    assert r.status_code == 400 and "already undone" in r.json()["detail"]


def test_pre_undo_snapshot_failure_is_503(client, monkeypatch):
    import subprocess as sp
    from backend.journal import Journal as J
    sha = run(client, {"prompt": "WRITE"})[-1]["commit"]

    def broken(self, message):
        raise sp.CalledProcessError(128, ["git"], stderr="index locked")

    monkeypatch.setattr(J, "snapshot", broken)
    r = client.post("/api/agent/undo", json={"commit": sha})
    assert r.status_code == 503 and "pre-undo" in r.json()["detail"]


# --- started event ------------------------------------------------------------

def test_started_is_first_event_of_a_run(client):
    events = run(client, {"prompt": "hi"})
    assert events[0] == {"kind": "started"}
    assert [e["kind"] for e in events].count("started") == 1


def test_no_run_errors_have_no_started(client):
    with client.websocket_connect("/ws/agent") as ws:
        ws.send_text("not json")
        assert ws.receive_json()["kind"] == "error"
        ws.send_json({"prompt": "SLEEP"})
        assert ws.receive_json() == {"kind": "started"}
        ws.send_json({"prompt": "again"})
        busy = ws.receive_json()
        while busy["kind"] != "error":  # skip events of the running SLEEP run
            busy = ws.receive_json()
        assert busy["message"] == "Another agent task is already running"
        ws.send_json({"type": "cancel"})
        until(ws, "changes")
