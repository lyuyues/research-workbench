from backend.settings import Settings


def test_health(client):
    assert client.get("/api/health").json() == {"ok": True}


def test_panels_in_order(client):
    ids = [p["id"] for p in client.get("/api/panels").json()]
    assert ids == ["today", "projects", "literature", "trends", "reading", "books", "audiobooks", "brain", "annotations",
                   "story", "writing", "meetings", "weekly", "automation", "log"]



def test_music_list_and_range(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from backend.app import create_app
    from backend.settings import Settings
    d = tmp_path / "music"; d.mkdir()
    (d / "Bach.mp3").write_bytes(b"ID3" + bytes(range(256)) * 4)
    (d / "notes.txt").write_text("x")
    (tmp_path / "research").mkdir(); (tmp_path / "git").mkdir()
    s = Settings(research_root=tmp_path / "research", git_dir=tmp_path / "git", music_dir=d)
    c = TestClient(create_app(s))
    assert c.get("/api/music").json() == [{"name": "Bach", "file": "Bach.mp3", "size": 1027}]
    r = c.get("/api/music/file", params={"name": "Bach.mp3"}, headers={"Range": "bytes=0-9"})
    assert r.status_code == 206 and len(r.content) == 10 and r.headers["content-type"] == "audio/mpeg"
    assert c.get("/api/music/file", params={"name": "../git"}).status_code == 404
    assert c.get("/api/music/file", params={"name": "notes.txt"}).status_code == 404


def test_project_links(client, settings):
    assert client.get("/api/project-links").json() == {}
    (settings.research_root / "project_links.json").write_text(
        '{"Alpha": {"notion": "https://www.notion.so/x", "bad": "javascript:alert(1)"}, "x": "nope"}', encoding="utf-8")
    assert client.get("/api/project-links").json() == {"Alpha": {"notion": "https://www.notion.so/x"}}
