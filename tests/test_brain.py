import dataclasses
import io
import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.brain import Brain, BrainError, NotFound
from backend.brain_import import Importer


@pytest.fixture
def brain(tmp_path) -> Brain:
    b = Brain(tmp_path / "brain" / "brain.db", gemini_key="")
    b.ensure_schema()
    with b.db(write=True) as c:
        c.execute("INSERT INTO domains (id, label, color) VALUES ('hci', 'HCI', '#4a8fe2')")
        c.executemany("INSERT INTO nodes (id, type, subtype, label, detail, is_data_confirmed, is_ai_generated) "
                      "VALUES (?, ?, ?, ?, ?, ?, ?)", [
                          ("project:Alpha", "project", None, "Alpha", "a project", 1, 0),
                          ("concept:scaffolding", "concept", None, "Scaffolding", "support that fades", 0, 1),
                          ("source:ways-of-knowing", "source", "book", "Ways of Knowing in HCI", "book", 0, 1),
                          ("question:q1", "question", None, "Why does scaffolding fade?", None, 0, 1),
                      ])
        c.execute("INSERT INTO node_domains VALUES ('concept:scaffolding', 'hci')")
        c.execute("INSERT INTO edges (source_node_id, target_node_id, edge_type) VALUES "
                  "('source:ways-of-knowing', 'concept:scaffolding', 'instantiates')")
        c.execute("INSERT INTO edges (source_node_id, target_node_id, edge_type) VALUES "
                  "('concept:scaffolding', 'project:Alpha', 'relates_to')")
        # rows from the old (keyless) import
        c.execute("INSERT INTO highlights_full (source_id, page, text, yue_comment) VALUES "
                  "('source:ways-of-knowing', 3, 'scaffolding is temporary support', 'key idea')")
        c.execute("INSERT INTO highlights_full (source_id, page, text) VALUES ('source:ways-of-knowing', 5, 'other text')")
    return b


def test_graph_and_state(brain):
    g = brain.graph()
    ids = {n["id"] for n in g["nodes"]}
    assert {"project:Alpha", "concept:scaffolding", "source:ways-of-knowing"} <= ids
    src = next(n for n in g["nodes"] if n["id"] == "source:ways-of-knowing")
    assert src["highlights"][0] == {"page": 3, "text": "scaffolding is temporary support", "yue_comment": "key idea"}
    concept = next(n for n in g["nodes"] if n["id"] == "concept:scaffolding")
    assert concept["domains"] == ["hci"]
    assert g["meta"]["domains"] == [{"id": "hci", "label": "HCI", "color": "#4a8fe2", "count": 1}]
    assert len(g["links"]) == 2 and all("id" in e for e in g["links"])
    assert brain.state() == {"node_confirmations": {}, "edge_confirmations": {}, "node_notes": {}, "node_renames": {},
                             "answers": {}}


def test_confirm_note_rename_answer(brain):
    brain.confirm_node("concept:scaffolding", "confirmed")
    eid = brain.graph()["links"][0]["id"]
    brain.confirm_edge(eid, "rejected")
    assert brain.set_note("concept:scaffolding", "  my note ") == "my note"
    brain.rename("concept:scaffolding", "Fading support")
    brain.set_answer("question:q1", "Because competence grows")
    st = brain.state()
    assert st["node_confirmations"] == {"concept:scaffolding": "confirmed"}
    assert st["edge_confirmations"] == {str(eid): "rejected"}
    assert st["node_notes"]["concept:scaffolding"]["text"] == "my note"
    assert st["node_renames"] == {"concept:scaffolding": "Fading support"}
    assert st["answers"] == {"question:q1": "Because competence grows"}
    brain.confirm_node("concept:scaffolding", "pending")
    brain.set_note("concept:scaffolding", "")
    st = brain.state()
    assert st["node_confirmations"] == {} and st["node_notes"] == {}
    with pytest.raises(NotFound):
        brain.confirm_node("concept:nope", "confirmed")
    with pytest.raises(BrainError):
        brain.confirm_node("concept:scaffolding", "maybe")
    with pytest.raises(NotFound):
        brain.set_answer("concept:scaffolding", "not a question")
    with sqlite3.connect(brain.path) as c:
        assert c.execute("SELECT COUNT(*) FROM actions_log").fetchone()[0] >= 7


def test_create_node_edge_merge(brain):
    n = brain.create_node("concept", "Fading", "detail", domains=["hci"])
    assert n["confirmed"] and n["domains"] == ["hci"] and n["id"].startswith("concept:user-")
    res = brain.create_edge(n["id"], "concept:scaffolding", "extends", "same idea")
    assert res["duplicate"] is False and res["edge"]["confirmed"]
    assert brain.create_edge(n["id"], "concept:scaffolding", "extends")["duplicate"] is True
    with pytest.raises(BrainError):
        brain.create_edge(n["id"], "concept:missing")
    brain.set_note(n["id"], "from the new node")
    brain.set_note("concept:scaffolding", "original")
    out = brain.merge(n["id"], "concept:scaffolding")
    assert out["dropped"] == 1  # the new edge would become a self-loop
    notes = brain.state()["node_notes"]
    assert n["id"] not in notes and "from the new node" in notes["concept:scaffolding"]["text"]
    assert n["id"] not in {x["id"] for x in brain.graph()["nodes"]}


def test_context_and_discover(brain):
    ctx = brain.context("concept:scaffolding")
    assert ctx[0]["source"]["id"] == "source:ways-of-knowing"
    assert ctx[0]["highlights"][0]["text"] == "scaffolding is temporary support"
    assert brain.discover("question:q1")[0]["id"] in {"concept:scaffolding", "source:ways-of-knowing"}


def test_ai_not_configured(brain):
    from backend.brain import AINotConfigured
    with pytest.raises(AINotConfigured):
        brain.extract("some text")
    with pytest.raises(AINotConfigured):
        brain.explain("concept:scaffolding")


class FakeStream(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_explain_streams_and_saves(brain):
    sent = []

    def opener(req, timeout=None):
        sent.append(json.loads(req.data))
        assert req.headers["X-goog-api-key"] == "k"
        chunks = [{"candidates": [{"content": {"parts": [{"text": t}]}}]} for t in ("Hello ", "there")]
        return FakeStream("".join(f"data: {json.dumps(c)}\n\n" for c in chunks).encode())
    b = Brain(brain.path, gemini_key="k", opener=opener)
    assert "".join(b.explain("concept:scaffolding", "")) == "Hello there"
    assert "Scaffolding" in sent[0]["systemInstruction"]["parts"][0]["text"]
    assert [m["role"] for m in b.messages("concept:scaffolding")] == ["user", "assistant"]
    b.clear_messages("concept:scaffolding")
    assert b.messages("concept:scaffolding") == []


# ---- Zotero import --------------------------------------------------------------------------------------------

class FakeZotero:
    def __init__(self):
        self.items_by_key = {
            "BOOK1": {"key": "BOOK1", "itemType": "book", "title": "Ways of Knowing in HCI",
                      "creators": [{"lastName": "Olson", "firstName": "Judith"}], "date": "2014",
                      "tags": [{"tag": "hci"}, {"tag": "notion"}]},
            "ATT1": {"key": "ATT1", "itemType": "attachment", "parentItem": "BOOK1", "title": "PDF"},
            "PAPER2": {"key": "PAPER2", "itemType": "journalArticle", "title": "A Brand New Paper (2026)",
                       "DOI": "10.1/xyz"},
            "ATT2": {"key": "ATT2", "itemType": "attachment", "parentItem": "PAPER2"},
            "A1": {"key": "A1", "version": 5, "itemType": "annotation", "parentItem": "ATT1", "annotationType": "highlight",
                   "annotationText": "scaffolding is temporary\nsupport", "annotationComment": "key idea",
                   "annotationPageLabel": "3"},
            "A2": {"key": "A2", "version": 6, "itemType": "annotation", "parentItem": "ATT2", "annotationType": "highlight",
                   "annotationText": "brand new passage", "annotationComment": "", "annotationPageLabel": "p. 12"},
            "A3": {"key": "A3", "version": 6, "itemType": "annotation", "parentItem": "ATT2", "annotationType": "ink",
                   "annotationText": "", "annotationComment": ""},
            "N1": {"key": "N1", "version": 7, "itemType": "note", "parentItem": "BOOK1", "note": "<p>My <b>summary</b></p>"},
        }
        self.calls = 0

    def versions(self, item_type):
        return {k: v["version"] for k, v in self.items_by_key.items() if v["itemType"] == item_type}

    def items(self, keys):
        self.calls += 1
        return [self.items_by_key[k] for k in keys if k in self.items_by_key]


def counts(b: Brain) -> dict:
    with sqlite3.connect(b.path) as c:
        return {t: c.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                for t in ("nodes", "edges", "highlights_full", "node_confirmations", "edge_confirmations", "node_notes",
                          "node_renames", "answers")}


def test_import_idempotent_and_preserves_user_choices(brain):
    brain.confirm_node("source:ways-of-knowing", "confirmed")
    brain.confirm_edge(brain.graph()["links"][0]["id"], "rejected")
    brain.set_note("source:ways-of-knowing", "keep me")
    brain.rename("source:ways-of-knowing", "WoK")
    brain.set_answer("question:q1", "an answer")
    z = FakeZotero()
    imp = Importer(brain, z, log=lambda m: None)
    s1 = imp.run()
    # A1 claimed the keyless legacy row (same source/page/text) instead of duplicating it
    assert s1["claimed"] == 1 and s1["new_sources"] == 1 and s1["new_highlights"] == 2  # A2 + note N1
    assert s1["first_import"] is True and brain.last_update()["new_highlights"] == 0
    before = counts(brain)
    state = brain.state()
    s2 = imp.run()
    assert s2["fetched"] == 0 and s2["new_highlights"] == 0 and s2["claimed"] == 0
    assert counts(brain) == before and brain.state() == state
    assert state["node_renames"] == {"source:ways-of-knowing": "WoK"}
    assert state["node_notes"]["source:ways-of-knowing"]["text"] == "keep me"
    g = {n["id"]: n for n in brain.graph()["nodes"]}
    new_src = next(n for n in g.values() if n.get("label") == "A Brand New Paper (2026)")
    assert new_src["id"] == "source:a-brand-new-paper" and new_src["subtype"] == "paper" and new_src["doi"] == "10.1/xyz"
    assert g["source:ways-of-knowing"]["author"] == "Olson, Judith" and g["source:ways-of-knowing"]["zotero_tags"] == ["hci"]
    assert g["source:ways-of-knowing"]["label"] == "Ways of Knowing in HCI"  # labels are never overwritten
    hl = brain.highlights("source:ways-of-knowing")
    assert {h["text"] for h in hl} == {"scaffolding is temporary support", "other text", "My summary"}

    # an edit in Zotero updates the row; a deletion removes it; the owner's state stays
    z.items_by_key["A1"].update(version=9, annotationComment="sharper idea")
    del z.items_by_key["A2"]
    s3 = imp.run()
    assert s3["updated"] == 1 and s3["removed"] == 1 and s3["first_import"] is False
    assert brain.state() == state
    assert any(h.get("yue_comment") == "sharper idea" for h in brain.highlights("source:ways-of-knowing"))
    assert brain.highlights(new_src["id"]) == []


def test_import_delete_guard(brain):
    z = FakeZotero()
    for i in range(30):
        z.items_by_key[f"X{i}"] = {"key": f"X{i}", "version": 1, "itemType": "annotation", "parentItem": "ATT2",
                                   "annotationType": "highlight", "annotationText": f"passage number {i}",
                                   "annotationPageLabel": str(i)}
    imp = Importer(brain, z, log=lambda m: None)
    imp.run()
    for i in range(30):
        del z.items_by_key[f"X{i}"]
    s = imp.run()
    assert "delete_guard" in s and s["removed"] == 0


# ---- routes ----------------------------------------------------------------------------------------------------

def test_routes(settings, brain):
    s = dataclasses.replace(settings, brain_db=brain.path)
    c = TestClient(create_app(s))
    assert c.get("/api/brain/graph").json()["nodes"]
    r = c.post("/api/brain/state/node/concept%3Ascaffolding/confirm", json={"status": "confirmed"})
    assert r.status_code == 200
    assert c.post("/api/brain/state/node/concept%3Ascaffolding/note", json={"text": "n"}).status_code == 200
    assert c.post("/api/brain/state/node/concept%3Anope/note", json={"text": "n"}).status_code == 404
    assert c.post("/api/brain/state/node/concept%3Ascaffolding/bogus", json={}).status_code == 404
    st = c.get("/api/brain/state").json()
    assert st["node_confirmations"] == {"concept:scaffolding": "confirmed"}
    r = c.post("/api/brain/edges/create", json={"source": "question:q1", "target": "concept:scaffolding", "type": "answers"})
    assert r.status_code == 200 and r.json()["edge"]["type"] == "answers"
    assert c.post(f"/api/brain/edges/{r.json()['edge']['id']}/delete").status_code == 200
    assert c.get("/api/brain/nodes/source%3Aways-of-knowing/highlights").json()["highlights"]
    assert c.get("/api/brain/nodes/concept%3Ascaffolding/context").json()["contexts"]
    assert c.post("/api/brain/extract", json={"text": "x"}).status_code == 503  # AI not configured
    assert c.post("/api/brain/explain", json={"node_id": "concept:scaffolding"}).status_code == 503
    assert c.get("/api/brain/screenshots/..%2Fbrain.db").status_code == 404
    assert c.get("/api/brain/last-update").json()["timestamp"] is None
    assert c.get("/api/brain/import").json()["zotero_configured"] is False
    assert c.post("/api/brain/import").status_code == 503


def test_missing_db_reads_empty(tmp_path):
    b = Brain(tmp_path / "nope" / "brain.db", gemini_key="")
    assert b.graph()["nodes"] == [] and b.state()["answers"] == {}
    assert not b.path.exists()  # reads never create the file
