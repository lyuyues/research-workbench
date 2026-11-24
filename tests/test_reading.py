import io
import json
import urllib.error

import pytest

from backend.reading import HL_END, HL_START, NotesConflict, Reading, normalize, slug
from backend.zotero import ZoteroAPI, ZoteroSync, annotation_json, load_config, md_to_html

PDF = b"%PDF-1.4 fake"


class Resp(io.BytesIO):
    def __init__(self, data: bytes, status=200, headers=None):
        super().__init__(data)
        self.status, self.headers = status, headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def opener_for(routes: dict):
    calls = []

    def op(req, timeout=None):
        url = req.full_url if hasattr(req, "full_url") else req
        calls.append(url)
        for k, v in routes.items():
            if k in url:
                return Resp(v)
        raise urllib.error.URLError("offline")
    op.calls = calls
    return op


def test_normalize_and_ids():
    m = normalize({"title": "  Creative  Intent: as state ", "url": "https://arxiv.org/abs/2611.01234v2"})
    assert m["arxiv"] == "2611.01234" and m["title"] == "Creative Intent: as state"
    assert normalize({"title": "x", "doi": "https://doi.org/10.1145/3544548.3581"})["doi"] == "10.1145/3544548.3581"
    with pytest.raises(ValueError):
        normalize({"title": ""})
    with pytest.raises(ValueError):
        normalize({"title": "x", "url": "javascript:alert(1)"})
    assert slug("Paper: a probe for sleep habits in teens") == "Paper-a-probe-for-sleep-habits-in-teens"
    assert slug("Creative Intent as an Evolving Shared State: video") == "Creative-Intent-as-an-Evolving-Shared-State"


def test_add_dedupe_download(tmp_path):
    op = opener_for({"arxiv.org/pdf/2611.01234": PDF})
    r = Reading(tmp_path, opener=op)
    x, new = r.add({"title": "Paper A", "url": "https://arxiv.org/abs/2611.01234", "source": "trends"})
    assert new and x["id"] == "arxiv-2611.01234"
    y, new2 = r.add({"title": "paper a!", "doi": "10.48550/arXiv.2611.01234"}, zotero=True)
    assert not new2 and y["id"] == x["id"] and y["zotero_want"] and y["doi"]
    assert r.download_pdf(x["id"]) == "ok"
    assert (tmp_path / "reading/pdfs/arxiv-2611.01234.pdf").read_bytes() == PDF
    v = r.view()["papers"][0]
    assert v["pdf_state"] == "ok" and v["zotero"]["state"] == "queued"
    # no open PDF → failed with a message
    z, _ = r.add({"title": "Closed", "url": "https://example.org/paper"})
    assert r.download_pdf(z["id"]) == "failed"
    assert "no open-access" in r.paper(z["id"])["pdf_error"]
    # HTML instead of a PDF
    r2 = Reading(tmp_path, opener=opener_for({"bad.pdf": b"<html>"}))
    w, _ = r2.add({"title": "Bad", "pdf_url": "https://e.org/bad.pdf"})
    assert r2.download_pdf(w["id"]) == "failed"


def test_zotero_paper_waits_for_mac(tmp_path):
    r = Reading(tmp_path, opener=opener_for({}))
    x, _ = r.add({"title": "Z", "zotero_key": "ABCD1234", "zotero_attachment": "EFGH5678", "arxiv": "2601.00001"})
    assert x["id"] == "arxiv-2601.00001"
    assert r.download_pdf(x["id"]) == "waiting-mac"
    assert r.view()["papers"][0]["pdf_state"] == "waiting-mac"
    assert r.zotero_keys(x) == ("ABCD1234", "EFGH5678")


def test_highlights_and_notes(tmp_path):
    r = Reading(tmp_path)
    x, _ = r.add({"title": "Paper B", "authors": "Ann Lee, Bo Wu", "year": "2026"})
    n = r.notes(x["id"])
    assert not n["exists"] and n["text"].startswith("# Paper B\n\n**Authors**: Ann Lee, Bo Wu")
    h = r.add_highlight(x["id"], {"page": 2, "rects": [[10, 700, 200, 712]], "text": "key  finding", "color": "green"})
    text = (tmp_path / x["notes"]).read_text()
    assert HL_START in text and "🟩 **p.3** “key finding”" in text
    with pytest.raises(ValueError):
        r.add_highlight(x["id"], {"page": 1, "rects": [[1, 2, 3]]})
    # notes saved from a stale copy that differs only in the highlights block → fine
    stale = n["text"]
    r.edit_highlight(x["id"], h["id"], comment="matters for Alpha")
    path = r.save_notes(x["id"], stale + "my thought\n", stale)
    saved = (tmp_path / path).read_text()
    assert "my thought" in saved and "— matters for Alpha" in saved and saved.count(HL_START) == 1
    with pytest.raises(NotesConflict):
        r.save_notes(x["id"], "x", stale)
    r.edit_highlight(x["id"], h["id"], delete=True)
    assert "_No highlights yet._" in (tmp_path / path).read_text()


def test_zotero_search(tmp_path):
    (tmp_path / "reading").mkdir()
    (tmp_path / "reading/zotero_index.json").write_text(json.dumps({"items": [
        {"key": "AAAA1111", "title": "Video modeling for sleep", "creators": ["Bellini"], "year": "2007", "pdf_key": "PPPP1111"},
        {"key": "BBBB2222", "title": "Sleep spindles", "creators": ["Smith"], "year": "2019"}]}))
    r = Reading(tmp_path)
    assert [i["key"] for i in r.zotero_search("bellini video")] == ["AAAA1111"]
    assert r.zotero_search("") == []


def test_md_to_html_and_annotation():
    out = md_to_html("# T\n\n**Bold** _it_ [x](https://a.b)\n- one\n- two\n> q\n<!-- hidden -->")
    assert "<h2>T</h2>" in out and "<strong>Bold</strong>" in out and "<ul>\n<li>one</li>" in out and "hidden" not in out
    a = annotation_json({"page": 3, "rects": [[1, 2, 3, 4]], "top": 700, "page_height": 792, "text": "t",
                         "comment": "", "color": "blue"}, "ATT00001")
    assert a["annotationSortIndex"] == "00003|000000|00092" and a["annotationColor"] == "#2ea8e5"
    assert json.loads(a["annotationPosition"]) == {"pageIndex": 3, "rects": [[1, 2, 3, 4]]}


def test_load_config(tmp_path):
    p = tmp_path / "z.json"
    assert load_config(p) is None
    p.write_text(json.dumps({"user_id": "1234567", "api_key": "a" * 24}))
    assert load_config(p) == {"user_id": "1234567", "api_key": "a" * 24}
    p.write_text(json.dumps({"user_id": "x", "api_key": "a" * 24}))
    assert load_config(p) is None


class FakeZotero:
    """Minimal in-memory Zotero web API."""

    def __init__(self):
        self.items = {"ITEM0001": {"key": "ITEM0001", "version": 1, "data": {}},
                      "ATT00001": {"key": "ATT00001", "version": 1, "data": {}}}
        self.n = 0
        self.log = []

    def __call__(self, req, timeout=None):
        method, url = req.get_method(), req.full_url
        path = url.split("/users/1234567", 1)[1]
        body = json.loads(req.data) if req.data else None
        self.log.append((method, path.split("?")[0]))
        if path.startswith("/settings/"):
            name = path[len("/settings/"):]
            st = self.__dict__.setdefault("settings", {})
            if method == "GET":
                if name not in st:
                    raise urllib.error.HTTPError(url, 404, "nf", {}, io.BytesIO(b""))
                return Resp(json.dumps(st[name]).encode())
            ver = int(req.get_header("If-unmodified-since-version") or 0)
            if ver != st.get(name, {}).get("version", 0):
                raise urllib.error.HTTPError(url, 412, "pre", {}, io.BytesIO(b""))
            st[name] = {"value": body["value"], "version": ver + 1}
            return Resp(b"", status=204)
        if method == "GET" and path.startswith("/collections"):
            return Resp(b"[]")
        if method == "POST" and path == "/collections":
            return Resp(json.dumps({"successful": {"0": {"key": "COLL0001"}}}).encode())
        if method == "POST" and path == "/items":
            ok = {}
            for i, it in enumerate(body):
                self.n += 1
                k = f"NEW{self.n:05d}"
                self.items[k] = {"key": k, "version": 1, "data": it}
                ok[str(i)] = {"key": k, "version": 1}
            return Resp(json.dumps({"successful": ok, "failed": {}}).encode())
        if "/children" in path and "itemType=note" in path:
            mine = [{"key": k, "data": v["data"]} for k, v in self.items.items() if v["data"].get("itemType") == "note"]
            return Resp(json.dumps(mine + getattr(self, "znotes", [])).encode())
        if "/children" in path:
            kids = [v for v in self.items.values() if v["data"].get("parentItem") == "ATT00001"]
            kids.append({"key": "IPAD0001", "data": {"annotationType": "highlight", "annotationText": "from ipad",
                         "annotationColor": "#ff6666", "annotationPosition": json.dumps({"pageIndex": 0, "rects": [[1, 2, 3, 4]]})}})
            return Resp(json.dumps(kids).encode())
        key = path.split("/items/")[1].split("?")[0]
        if key not in self.items:
            raise urllib.error.HTTPError(url, 404, "nf", {}, io.BytesIO(b""))
        if method == "GET":
            return Resp(json.dumps(self.items[key]).encode())
        if method == "PATCH":
            self.items[key]["data"].update(body)
            self.items[key]["version"] += 1
            return Resp(b"", status=204)
        if method == "DELETE":
            del self.items[key]
            return Resp(b"", status=204)
        raise AssertionError(method)


def test_zotero_sync(tmp_path):
    r = Reading(tmp_path)
    x, _ = r.add({"title": "Synced", "zotero_key": "ITEM0001", "zotero_attachment": "ATT00001"})
    fz = FakeZotero()
    z = ZoteroSync(r, ZoteroAPI("1234567", "k" * 24, opener=fz))
    assert z.ensure_collection() == "COLL0001"
    h = r.add_highlight(x["id"], {"page": 0, "rects": [[10, 10, 50, 20]], "text": "hello"})
    out = z.sync_paper(x["id"])
    assert out["note"] == "created" and out["pushed"] == 1 and out["pulled"] == 1
    hl = r.annotations(x["id"])["highlights"][0]
    note_key = r.server_state()["papers"][x["id"]]["note_key"]
    assert hl["zotero_key"] and fz.items[note_key]["data"]["parentItem"] == "ITEM0001"
    assert "from ipad" in (tmp_path / x["notes"]).read_text()  # pulled Zotero highlight lands in the notes block
    # second sync: nothing changed
    out = z.sync_paper(x["id"])
    assert out["note"] == "unchanged" and out["pushed"] == 0
    # comment change → PATCH; delete → DELETE
    r.edit_highlight(x["id"], h["id"], comment="why")
    assert z.sync_paper(x["id"])["updated"] == 1
    assert fz.items[hl["zotero_key"]]["data"]["annotationComment"] == "why"
    r.edit_highlight(x["id"], h["id"], delete=True)
    assert z.sync_paper(x["id"])["deleted"] == 1 and hl["zotero_key"] not in fz.items
    assert r.annotations(x["id"])["deleted"] == []


def test_zotero_waits_for_item(tmp_path):
    r = Reading(tmp_path)
    x, _ = r.add({"title": "Not yet", "zotero_key": "MISS0001"})
    z = ZoteroSync(r, ZoteroAPI("1234567", "k" * 24, opener=FakeZotero()))
    assert "not on zotero.org" in z.sync_paper(x["id"])["waiting"]
    y, _ = r.add({"title": "No key"}, zotero=True)
    assert "Mac bridge" in z.sync_paper(y["id"])["waiting"]


def test_zotero_notes_pulled_read_only(tmp_path):
    from backend.reading import ZNOTES_MARK
    from backend.zotero import html_to_md
    r = Reading(tmp_path)
    x, _ = r.add({"title": "Book", "zotero_key": "ITEM0001", "zotero_attachment": "ATT00001"})
    fz = FakeZotero()
    fz.znotes = [{"key": "ZNOTE001", "data": {"itemType": "note", "dateAdded": "2026-11-01",
                  "note": "<h1>Ch. 3</h1><p>Jung on <strong>persona</strong> &amp; shadow</p><ul><li>one</li><li>two</li></ul>"}}]
    z = ZoteroSync(r, ZoteroAPI("1234567", "k" * 24, opener=fz))
    out = z.sync_paper(x["id"])
    assert out["pulled_notes"] == 1
    text = (tmp_path / x["notes"]).read_text()
    assert ZNOTES_MARK in text and "Jung on **persona** & shadow" in text and "- one\n- two" in text
    # the platform's own pushed note does not carry the Zotero notes back (no loop)
    own = fz.items[r.server_state()["papers"][x["id"]]["note_key"]]["data"]["note"]
    assert "persona" not in own
    # editing the notes on the platform keeps the pulled section
    cur = r.notes(x["id"])["text"]
    r.save_notes(x["id"], "# Book\n\nmy thought\n", cur)
    assert "persona" in (tmp_path / x["notes"]).read_text()
    # second sync: own note is not pulled as a Zotero note
    assert "pulled_notes" not in z.sync_paper(x["id"])
    assert html_to_md("<p>a<br>b</p>") == "a\nb"


def test_zotero_page_position(tmp_path):
    fz = FakeZotero()
    z = ZoteroSync(Reading(tmp_path), ZoteroAPI("1234567", "k" * 24, opener=fz))
    assert z.get_page("ATT00001") is None
    z.set_page("ATT00001", 20)
    assert z.get_page("ATT00001") == 20
    z.set_page("ATT00001", 21)
    assert fz.settings["lastPageIndex_u_ATT00001"] == {"value": 21, "version": 2}
    n = len(fz.log)
    z.set_page("ATT00001", 21)  # unchanged: no write
    assert [m for m, _ in fz.log[n:]] == ["GET"]


def test_reading_api(client, settings):
    r = client.post("/api/reading/add", json={"title": "API paper", "url": "https://example.org/x", "source": "trends"})
    assert r.status_code == 200
    pid = r.json()["id"]
    v = client.get("/api/reading").json()
    assert v["papers"][0]["id"] == pid and v["zotero_configured"] is False
    h = client.post(f"/api/reading/paper/{pid}/highlights", json={"page": 0, "rects": [[1, 2, 3, 4]], "text": "t"})
    assert h.status_code == 200
    d = client.get(f"/api/reading/paper/{pid}").json()
    assert len(d["highlights"]) == 1 and d["notes"]["exists"]
    assert client.post(f"/api/reading/paper/{pid}/highlights/{h.json()['id']}", json={"comment": "c"}).status_code == 200
    n = d["notes"]["text"]
    assert client.post(f"/api/reading/paper/{pid}/notes", json={"text": n + "more", "expect": n}).status_code == 200
    assert client.post(f"/api/reading/paper/{pid}/notes", json={"text": "x", "expect": "old"}).status_code == 409
    assert client.post(f"/api/reading/paper/{pid}", json={"status": "reading"}).status_code == 200
    assert client.post(f"/api/reading/paper/{pid}", json={"status": "bogus"}).status_code == 422
    assert client.post(f"/api/reading/paper/{pid}", json={"tags": [" #Sleep ", "video  gen", "sleep", ""], "rating": 4}).status_code == 200
    p = client.get("/api/reading").json()["papers"][0]
    assert p["tags"] == ["Sleep", "video gen"] and p["rating"] == 4
    assert client.post(f"/api/reading/paper/{pid}", json={"rating": 6}).status_code == 422
    assert client.post(f"/api/reading/paper/{pid}", json={"rating": 0}).status_code == 200
    assert client.get("/api/reading").json()["papers"][0]["rating"] == 0
    assert client.get(f"/api/reading/paper/{pid}/pdf").status_code == 404
    assert client.get("/api/reading/paper/../etc/pdf").status_code == 404
    assert client.post(f"/api/reading/paper/{pid}/sync").status_code == 503
    assert client.get(f"/api/reading/paper/{pid}/position").json() == {"page": None, "source": None}
    assert client.post(f"/api/reading/paper/{pid}/position", json={"page": 7}).status_code == 200
    assert client.get(f"/api/reading/paper/{pid}/position").json() == {"page": 7, "source": "platform"}
    assert client.post(f"/api/reading/paper/{pid}/position", json={"page": -1}).status_code == 422


def test_chinese_titles_are_distinct(tmp_path):
    r = Reading(tmp_path)
    a, _ = r.add({"title": "Memories, Dreams, Reflections", "zotero_key": "R7PP6DBN"})
    b, new = r.add({"title": "The Mythical Man-Month", "zotero_key": "98YAGV3H"})
    assert new and b["id"] != a["id"]
    c, new = r.add({"title": "The Innovator's Dilemma"})
    assert new and c["id"] not in (a["id"], b["id"])
    assert r.add({"title": "The Innovator's Dilemma"})[1] is False            # same title still dedupes
    assert r.add({"title": "Same Title", "zotero_key": "AAAA1111"})[1] is True
    assert r.add({"title": "Same Title", "zotero_key": "BBBB2222"})[1] is True   # two Zotero items, same title


def test_paper_detail_reports_ocr_status(client, settings):
    pid = client.post("/api/reading/add", json={"title": "Scanned book", "url": "https://example.org/b"}).json()["id"]
    assert client.get(f"/api/reading/paper/{pid}").json()["ocr"] is None   # no PDF yet
    pdf = settings.research_root / "reading" / "pdfs" / f"{pid}.pdf"
    pdf.parent.mkdir(parents=True, exist_ok=True)
    pdf.write_bytes(b"%PDF-1.4 scan")
    (pdf.parent / f"{pid}.ocr.json").write_text(json.dumps({"state": "running", "done": 40, "total": 186, "updated": 1}))
    assert client.get(f"/api/reading/paper/{pid}").json()["ocr"]["done"] == 40
