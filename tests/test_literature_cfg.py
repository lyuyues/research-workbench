import pytest

from backend.literature_cfg import LiteratureConfig

YAML_TEXT = """\
api:
  base_url: https://api.semanticscholar.org/graph/v1
  api_key: null
discovery:
  lookback_days: 7
keyword_groups:
  core:
    query: sleep technology intervention
    project: all
  video:
    query: video modeling sleep interactive
    project: BETA
tracked_authors:
  # --- S tier ---
  - name: Juan Pablo Hourcade        # child interaction + VR
    id: '1738111'
    tier: S
  - name: Pattie Maes                # wearables
    id: '1701876'
    tier: A
venues:
  tier1:
  # HCI
  - CHI
  - ASSETS
  tier2:
  - UIST
research_profile:
  researcher: Alex Doe
  areas:
  - HCI
  - Sleep Research
  projects:
    Alpha: probe
    BETA: video
"""


@pytest.fixture
def cfg(tmp_path):
    d = tmp_path / "literature-radar"
    d.mkdir()
    (d / "config.yaml").write_text(YAML_TEXT, encoding="utf-8")
    return LiteratureConfig(tmp_path)


def test_view(cfg):
    v = cfg.view()
    assert [g["id"] for g in v["keyword_groups"]] == ["core", "video"]
    assert v["tracked_authors"][0] == {"name": "Juan Pablo Hourcade", "id": "1738111", "tier": "S"}
    assert v["venues"] == {"tier1": ["CHI", "ASSETS"], "tier2": ["UIST"]}
    assert v["projects"] == ["all", "cross", "Alpha", "BETA"] and v["lookback_days"] == 7


def test_save_keeps_comments_and_other_keys(cfg):
    v = cfg.view()
    v["keyword_groups"].append({"id": "", "query": "sleep tracking generative AI", "project": "BETA"})
    v["keyword_groups"][0]["query"] = "sleep technology"
    v["tracked_authors"] = [a for a in v["tracked_authors"] if a["name"] != "Pattie Maes"]
    v["tracked_authors"].append({"name": "Sang Won Lee", "id": "", "tier": "A"})
    v["venues"]["tier2"].append("CSCW")
    v["areas"].append("Generative video")
    v["lookback_days"] = 14
    out = cfg.save(v)
    assert out["keyword_groups"][-1] == {"id": "sleep-tracking-generative-ai", "query": "sleep tracking generative AI", "project": "BETA"}
    text = cfg.path.read_text(encoding="utf-8")
    assert "# child interaction + VR" in text and "# --- S tier ---" in text and "# HCI" in text
    assert "Pattie Maes" not in text and "base_url: https://api.semanticscholar.org" in text
    assert "api_key: null" in text and "researcher: Alex Doe" in text
    v2 = cfg.view()
    assert v2["tracked_authors"][-1] == {"name": "Sang Won Lee", "id": "", "tier": "A"}  # id null → radar resolves by name
    assert v2["venues"]["tier2"] == ["UIST", "CSCW"] and v2["areas"][-1] == "Generative video" and v2["lookback_days"] == 14
    assert v2["keyword_groups"][0]["query"] == "sleep technology"


def test_unchanged_save_keeps_content(cfg):
    from ruamel.yaml import YAML
    load = YAML(typ="safe").load
    before = load(cfg.path.read_text())
    cfg.save(cfg.view())
    assert load(cfg.path.read_text()) == before


@pytest.mark.parametrize("patch", [
    {"keyword_groups": []},
    {"keyword_groups": [{"id": "x", "query": "sleep", "project": "all"}]},             # one word never matches
    {"keyword_groups": [{"id": "x", "query": "a b", "project": "MARS"}]},
    {"keyword_groups": [{"id": "x", "query": "a b", "project": "all"}, {"id": "x", "query": "c d", "project": "all"}]},
    {"tracked_authors": [{"name": "A", "id": "abc", "tier": "S"}]},
    {"tracked_authors": [{"name": "A", "tier": "Z"}]},
    {"tracked_authors": [{"name": "A"}, {"name": "a"}]},
    {"venues": {"tier1": ["CHI"], "tier2": ["CHI"]}},
    {"lookback_days": 0},
])
def test_validation(cfg, patch):
    with pytest.raises(ValueError):
        cfg.save({**cfg.view(), **patch})


def test_api(client, settings):
    d = settings.research_root / "literature-radar"
    d.mkdir(parents=True, exist_ok=True)
    (d / "config.yaml").write_text(YAML_TEXT, encoding="utf-8")
    v = client.get("/api/literature/config").json()
    v["keyword_groups"].append({"id": "hai", "query": "human-AI interaction accessibility", "project": "cross"})
    r = client.post("/api/literature/config", json={"config": v})
    assert r.status_code == 200 and r.json()["keyword_groups"][-1]["id"] == "hai"
    assert "human-AI interaction accessibility" in (d / "config.yaml").read_text()
    bad = {**v, "keyword_groups": []}
    assert client.post("/api/literature/config", json={"config": bad}).status_code == 400
    assert any(x["action"] == "literature radar settings saved" for x in client.get("/api/oplog").json())
