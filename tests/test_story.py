import json

import pytest

from backend.story import Story, validate_items
from backend.workspace import EditConflict

ITEMS = [
    {"id": "s1", "kind": "section", "x": 0, "y": 0, "w": 300, "h": 200, "text": "Claim 1", "color": "plain"},
    {"id": "c1", "kind": "card", "x": 10, "y": 20, "w": 160, "h": 84, "text": "Evidence A", "color": "support"},
    {"id": "n1", "kind": "note", "x": 0, "y": -40, "w": 200, "text": "Claim: …", "size": "large"},
    {"id": "a1", "kind": "arrow", "from": "s1", "to": "c1"},
    {"id": "a2", "kind": "arrow", "from": "c1", "to": "gone"},
]


def test_validate_items_keeps_shape_and_drops_dangling_arrows():
    out = validate_items(ITEMS)
    assert [i["id"] for i in out] == ["s1", "c1", "n1", "a1"]
    assert out[1]["color"] == "support" and "h" not in out[2] and out[2]["size"] == "large"


@pytest.mark.parametrize("bad", [
    [{"id": "x", "kind": "blob", "x": 0, "y": 0, "w": 50, "h": 50}],
    [{"id": "x", "kind": "card", "x": 0, "y": 0, "w": 50, "h": 50, "color": "neon"}],
    [{"id": "x", "kind": "card", "x": "0", "y": 0, "w": 50, "h": 50}],
    [{"id": "bad id!", "kind": "note", "x": 0, "y": 0, "w": 50}],
    [{"id": "x", "kind": "note", "x": 0, "y": 0, "w": 50}, {"id": "x", "kind": "note", "x": 0, "y": 0, "w": 50}],
    [{"id": "x", "kind": "note", "x": 0, "y": 0, "w": 50, "text": "a" * 5000}],
    "not a list",
])
def test_validate_items_rejects(bad):
    with pytest.raises(ValueError):
        validate_items(bad)


def test_save_versions_and_conflict(tmp_path):
    (tmp_path / "projects.yaml").write_text("projects:\n  - {name: Alpha}\n")
    s = Story(tmp_path)
    assert s.load("Alpha")["version"] == 0 and s.load("Alpha")["items"] == []
    out = s.save("Alpha", 0, ITEMS[:2])
    assert out["version"] == 1
    on_disk = json.loads((tmp_path / "Alpha/story/canvas.json").read_text())
    assert on_disk["version"] == 1 and on_disk["items"][1]["text"] == "Evidence A"
    with pytest.raises(EditConflict):
        s.save("Alpha", 0, ITEMS[:1])
    with pytest.raises(ValueError):
        s.load("../etc")


def test_story_api(client):
    r = client.get("/api/story/Alpha")
    assert r.status_code == 200 and r.json()["version"] == 0
    r = client.post("/api/story/Alpha", json={"version": 0, "items": ITEMS[:2]})
    assert r.status_code == 200 and r.json()["version"] == 1
    assert client.post("/api/story/Alpha", json={"version": 0, "items": []}).status_code == 409
    assert client.post("/api/story/Alpha", json={"version": 1, "items": [{"id": "x", "kind": "blob"}]}).status_code == 400
    assert client.get("/api/story/Nope").status_code == 400


PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 32


def test_image_items_and_upload(client):
    r = client.post("/api/story/Alpha/image", content=PNG, headers={"Content-Type": "image/png"})
    assert r.status_code == 200
    src = r.json()["src"]
    assert src.endswith(".png")
    got = client.get(f"/api/story/Alpha/image/{src}")
    assert got.status_code == 200 and got.content == PNG
    assert client.get("/api/story/Alpha/image/..%2Fcanvas.json").status_code == 404
    assert client.post("/api/story/Alpha/image", content=b"<svg/>").status_code == 400
    item = {"id": "p1", "kind": "image", "x": 0, "y": 0, "w": 200, "h": 100, "text": "fig", "src": src}
    assert client.post("/api/story/Alpha", json={"version": 0, "items": [item]}).json()["items"][0]["src"] == src
    bad = {**item, "src": "../x.png"}
    assert client.post("/api/story/Alpha", json={"version": 1, "items": [bad]}).status_code == 400
