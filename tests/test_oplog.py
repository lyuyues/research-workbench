import json
from pathlib import Path

from fastapi.testclient import TestClient

from backend.oplog import OpLog


def test_append_and_read_newest_first(tmp_path: Path):
    log = OpLog(tmp_path / "s" / "oplog.jsonl")
    log.append("agent", "run started", "hello", panel="today", files=[])
    log.append("claude-mac", "deploy", "x" * 5000)
    (tmp_path / "s" / "oplog.jsonl").open("a").write("not json\n")
    out = log.read()
    assert [e["action"] for e in out] == ["deploy", "run started"]
    assert len(out[0]["detail"]) == 2000
    assert out[1]["panel"] == "today" and "files" not in out[1]
    assert (tmp_path / "s" / "oplog.jsonl").stat().st_mode & 0o777 == 0o600
    assert OpLog(tmp_path / "missing.jsonl").read() == []


def test_agent_run_and_undo_are_logged(client: TestClient):
    with client.websocket_connect("/ws/agent") as ws:
        ws.send_json({"prompt": "WRITE please", "context": {"panel": "today"}})
        while (ev := ws.receive_json())["kind"] != "changes":
            pass
    commit = ev["commit"]
    assert client.post("/api/agent/undo", json={"commit": commit}).status_code == 200
    log = client.get("/api/oplog").json()
    actions = [e["action"] for e in log]
    assert actions[:3] == ["undo", "run finished", "run started"]
    assert actions[-1] == "service started"
    finished = log[1]
    assert finished["files"] == ["note.md"] and finished["commit"] == commit
    assert log[2]["detail"] == "WRITE please" and log[2]["panel"] == "today"


def test_failed_run_is_logged(client: TestClient):
    with client.websocket_connect("/ws/agent") as ws:
        ws.send_json({"prompt": "FAIL now"})
        while ws.receive_json()["kind"] != "changes":
            pass
    assert client.get("/api/oplog").json()[0]["action"] == "run failed"
