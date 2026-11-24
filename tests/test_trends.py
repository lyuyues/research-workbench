import json

import pytest

from backend.trends import Trends, validate_config

CFG = {"topics": [{"name": "AI agent", "keywords": ["agentic", " AI agent "]}, {"id": "vr", "name": "VR", "keywords": ["sleep"]}],
       "sources": [{"name": "OpenAI", "url": "https://openai.com/news/rss.xml", "kind": "lab", "all": True}],
       "arxiv": {"categories": ["cs.HC", "bad cat!"]}}


def test_validate_config():
    c = validate_config(CFG)
    assert [t["id"] for t in c["topics"]] == ["ai-agent", "vr"]
    assert c["topics"][0]["keywords"] == ["agentic", "AI agent"]
    assert c["arxiv"]["categories"] == ["cs.HC"] and c["sources"][0]["enabled"] is True
    assert c["sources"][0]["watch"] == "feed"
    lab = validate_config({**CFG, "sources": [{"name": "Stanford HCI", "url": "https://hci.stanford.edu/", "kind": "hcilab", "watch": "page"}]})
    assert lab["sources"][0]["kind"] == "hcilab" and lab["sources"][0]["watch"] == "page"
    for bad in [{"topics": []}, {"topics": [{"name": "x", "keywords": []}]},
                {**CFG, "sources": [{"name": "x", "url": "javascript:alert(1)"}]},
                {**CFG, "sources": [{"name": "x", "url": "https://a.b", "kind": "evil"}]},
                {**CFG, "sources": [{"name": "x", "url": "https://a.b", "watch": "scrape-all"}]}]:
        with pytest.raises(ValueError):
            validate_config(bad)


def write_day(root, day, items, ai=None):
    d = root / "trends/data"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{day}.json").write_text(json.dumps({"date": day, "generated": 1, "items": items, "errors": [{"source": "x", "error": "y"}]}))
    if ai is not None:
        (d / f"{day}.ai.json").write_text(json.dumps(ai))


def test_view_merges_ai(tmp_path):
    write_day(tmp_path, "2026-11-09", [{"id": "old", "title": "Old"}])
    write_day(tmp_path, "2026-11-10", [{"id": "a", "title": "A"}, {"id": "b", "title": "B"}],
              {"headline": "Today", "items": {"a": {"zh": "Key point", "relevance": 3, "why": "Alpha"}}})
    t = Trends(tmp_path)
    v = t.view()
    assert v["days"] == ["2026-11-10", "2026-11-09"] and v["headline"] == "Today" and v["summarized"]
    assert v["items"][0]["zh"] == "Key point" and v["items"][1]["relevance"] is None
    assert t.view("2026-11-09")["summarized"] is False
    with pytest.raises(ValueError):
        t.view("../../etc")


def test_api(client, settings):
    assert client.get("/api/trends").json()["days"] == []
    r = client.post("/api/trends/config", json={"config": CFG})
    assert r.status_code == 200 and r.json()["topics"][1]["name"] == "VR"
    assert json.loads((settings.research_root / "trends/config.json").read_text())["topics"][0]["id"] == "ai-agent"
    assert client.post("/api/trends/config", json={"config": {"topics": []}}).status_code == 400
    assert client.get("/api/trends").json()["config"]["topics"][0]["name"] == "AI agent"
    assert any(r["action"] == "trends config saved" for r in client.get("/api/oplog").json())
    assert client.get("/api/trends?day=2020-01-01").status_code == 400


def test_saved_items(tmp_path):
    t = Trends(tmp_path)
    it = {"id": "a", "title": "A paper", "url": "https://arxiv.org/abs/1", "kind": "academic", "zh": "Key point", "relevance": 3, "extra": "x"}
    items = t.set_saved(it, True, "2026-11-10")
    assert items[0]["id"] == "a" and items[0]["day"] == "2026-11-10" and "extra" not in items[0]
    t.set_saved({**it, "id": "b", "title": "B"}, True)
    assert [x["id"] for x in t.saved()] == ["b", "a"]
    assert [x["id"] for x in t.set_saved({**it, "id": "a"}, True)] == ["a", "b"]  # re-save moves it to the top, no duplicate
    assert [x["id"] for x in t.set_saved({"id": "a"}, False)] == ["b"]
    assert t.view()["saved"][0]["id"] == "b"  # listed even with no day files
    for bad in [{"title": "x", "url": "https://a.b"}, {"id": "c", "title": "x", "url": "javascript:alert(1)"}, {"id": "c", "url": "https://a.b"}]:
        with pytest.raises(ValueError):
            t.set_saved(bad, True)


def test_saved_api(client, settings):
    it = {"id": "a", "title": "A", "url": "https://arxiv.org/abs/1"}
    r = client.post("/api/trends/saved", json={"item": it, "saved": True, "day": "2026-11-10"})
    assert r.status_code == 200 and r.json()["saved"][0]["id"] == "a"
    assert client.get("/api/trends").json()["saved"][0]["title"] == "A"
    assert client.post("/api/trends/saved", json={"item": {"id": "a"}, "saved": False}).json()["saved"] == []
    assert client.post("/api/trends/saved", json={"item": {"id": "x", "title": "x", "url": "ftp://x"}, "saved": True}).status_code == 400
