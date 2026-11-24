import json

from fastapi.testclient import TestClient

from backend import audiobook as ab
from backend.app import create_app
from backend.settings import Settings


def _app(tmp_path):
    root = tmp_path / "ab"; (root / "library" / "qdl").mkdir(parents=True)
    (root / "library" / "qdl" / "book.json").write_text(json.dumps(
        {"title": "Drive", "added": "2026-11-16T00:00:00+00:00", "zotero_key": "AAAA1111", "chapters": []}))
    book = lambda k, t, att=True: {"key": k, "title": t, "authors": ["X"], "year": "2020", "collections": ["6. BOOKS / Life"],
                                    "tags": [], "attachment": {"key": "ATT00001", "format": "pdf", "file": "a.pdf", "size": 1} if att else None,
                                    "file_on_mac": att}
    (root / "zotero_books.json").write_text(json.dumps({"books": [
        book("AAAA1111", "Drive"), book("BBBB2222", "Social Psychology"), book("CCCC3333", "No file", False),
        book("DDDD4444", "The Rebel")]}))
    (root / "inbox").mkdir()
    (root / "inbox" / "The Rebel.pdf").write_bytes(b"%PDF")
    (root / "inbox" / "The Rebel.meta.json").write_text(json.dumps({"title": "The Rebel", "zotero_key": "DDDD4444"}))
    tok = tmp_path / "tok"; tok.write_text("t" * 32)
    (tmp_path / "research").mkdir(); (tmp_path / "git").mkdir()
    s = Settings(research_root=tmp_path / "research", git_dir=tmp_path / "git", audiobook_root=root, podcast_token_file=tok)
    return TestClient(create_app(s)), root


def test_bookshelf_status_and_request(tmp_path):
    c, root = _app(tmp_path)
    books = {b["key"]: b for b in c.get("/api/bookshelf").json()["books"]}
    assert books["AAAA1111"]["audiobook"] == "qdl"
    assert books["DDDD4444"]["status"] == "converting"
    assert books["BBBB2222"]["status"] is None
    assert c.post("/api/bookshelf/CCCC3333/audiobook").status_code == 400
    assert c.post("/api/bookshelf/ZZZZ9999/audiobook").status_code == 404
    assert c.post("/api/bookshelf/BBBB2222/audiobook").json() == {"status": "requested"}
    assert (root / "requests" / "BBBB2222.json").is_file()
    assert {b["key"]: b for b in c.get("/api/bookshelf").json()["books"]}["BBBB2222"]["status"] == "requested"
    (root / "requests" / "BBBB2222.json").write_text(json.dumps({"error": "no local PDF"}))
    b = {b["key"]: b for b in c.get("/api/bookshelf").json()["books"]}["BBBB2222"]
    assert b["status"] == "error" and b["error"] == "no local PDF"


def test_queue_reads_sidecar(tmp_path):
    inbox = tmp_path / "inbox"; inbox.mkdir()
    (inbox / "a.epub").write_bytes(b"x")
    (inbox / "a.meta.json").write_text(json.dumps({"title": "A", "zotero_key": "KKKK0000"}))
    assert ab.queued(tmp_path) == [{"title": "A", "zotero_key": "KKKK0000"}]


def test_bookshelf_live_progress(tmp_path):
    c, root = _app(tmp_path)
    (root / "status.json").write_text(json.dumps({"zotero_key": "DDDD4444", "stage": "ocr", "done": 40, "total": 300}))
    books = {b["key"]: b for b in c.get("/api/bookshelf").json()["books"]}
    assert books["DDDD4444"]["progress"] == {"stage": "ocr", "done": 40, "total": 300}
    assert books["BBBB2222"]["progress"] is None


def test_report_writes_and_run_clears_status(tmp_path):
    from backend import audiobook
    audiobook.STATUS.update({"_file": str(tmp_path / "status.json"), "zotero_key": "K", "title": "T"})
    audiobook.report("tts", 2, 9)
    assert audiobook.load_status(tmp_path) | {"updated": 0} == {"zotero_key": "K", "title": "T", "stage": "tts",
                                                               "done": 2, "total": 9, "updated": 0}
    audiobook.STATUS.clear()
    (tmp_path / "inbox").mkdir()
    audiobook.run_inbox(tmp_path)
    assert not (tmp_path / "status.json").exists()


def test_bookshelf_file(tmp_path):
    c, root = _app(tmp_path)
    (root / "books").mkdir()
    (root / "books" / "BBBB2222.pdf").write_bytes(b"%PDF-1.4 book")
    books = {b["key"]: b for b in c.get("/api/bookshelf").json()["books"]}
    assert books["BBBB2222"]["readable"] is True and books["AAAA1111"]["readable"] is False
    r = c.get("/api/bookshelf/BBBB2222/file")
    assert r.status_code == 200 and r.content == b"%PDF-1.4 book"
    assert r.headers["content-type"] == "application/pdf" and r.headers["content-disposition"].startswith("inline")
    assert c.get("/api/bookshelf/AAAA1111/file").status_code == 404
    assert c.get("/api/bookshelf/..%2Fx/file").status_code == 404


def test_bookshelf_read_opens_in_reader(tmp_path):
    c, root = _app(tmp_path)
    (root / "books").mkdir()
    (root / "books" / "BBBB2222.pdf").write_bytes(b"%PDF-1.4 book")
    r = c.post("/api/bookshelf/BBBB2222/read")
    assert r.status_code == 200, r.text
    pid = r.json()["id"]
    d = c.get(f"/api/reading/paper/{pid}").json()["paper"]
    assert d["title"] == "Social Psychology" and "book" in d["tags"] and d["zotero_key"] == "BBBB2222"
    assert c.get(f"/api/reading/paper/{pid}/pdf").content == b"%PDF-1.4 book"
    again = c.post("/api/bookshelf/BBBB2222/read").json()
    assert again == {"id": pid, "new": False}
    assert c.post("/api/bookshelf/ZZZZ9999/read").status_code == 404
