import json

from fastapi.testclient import TestClient

from backend import audiobook as ab
from backend.app import create_app
from backend.settings import Settings


def test_running_heads_and_join():
    pages = [f"My Book\nThe text on page {i} goes on and\non here.\n{i}" for i in range(1, 9)]
    out = ab.strip_running_heads(pages)
    assert all("My Book" not in p and not p.strip().endswith(str(i)) for i, p in enumerate(out, 1))
    assert ab.join_lines("The text goes on and\non here. Hyph-\nenated.") == "The text goes on and on here. Hyphenated."


def test_detect_lang_and_plan():
    assert ab.detect_lang("An English book " * 50) == "en"
    secs = [("Contents", "1 ... 2"), ("Preface", "short"), ("Chapter 1", "A sentence. " * 100),
            ("Chapter 2", "Long one. " * 6000), ("Index", "a, 1")]
    eps = ab.plan_episodes(secs, "en")
    assert eps[0]["title"] == "Preface" and eps[0]["text"].startswith("short")
    assert [e["title"] for e in eps[1:]] == ["Chapter 2 (1/3)", "Chapter 2 (2/3)", "Chapter 2 (3/3)"]
    assert all(len(e["text"]) <= ab.MAX_CHARS["en"] for e in eps)


def _lib(tmp_path):
    root = tmp_path / "ab"
    d = root / "library" / "my-book"; d.mkdir(parents=True)
    (d / "001.mp3").write_bytes(b"ID3" + b"x" * 100)
    (d / "book.json").write_text(json.dumps({"title": "My <Book>", "author": "A. Writer", "added": "2026-11-15T10:00:00+00:00", "chapters": [
        {"n": 1, "title": "One", "file": "001.mp3", "bytes": 103, "duration": 3725},
        {"n": 2, "title": "Two", "file": "002.mp3"}]}))
    tok = tmp_path / "tok"; tok.write_text("t" * 32)
    (tmp_path / "research").mkdir(); (tmp_path / "git").mkdir()
    return Settings(research_root=tmp_path / "research", git_dir=tmp_path / "git",
                    audiobook_root=root, podcast_token_file=tok)


def test_feed_and_episode(tmp_path):
    c = TestClient(create_app(_lib(tmp_path)))
    t = "t" * 32
    r = c.get(f"/podcast/{t}/feed.xml")
    assert r.status_code == 200 and "rss" in r.headers["content-type"]
    assert "My &lt;Book&gt; · 01 One" in r.text and "Two" not in r.text  # unfinished episode left out
    assert '<podcast:season name="My &lt;Book&gt; · A. Writer">1</podcast:season>' in r.text
    assert "<itunes:author>A. Writer</itunes:author>" in r.text
    assert f"/podcast/{t}/my-book/001.mp3" in r.text and "1:02:05" in r.text
    r = c.get(f"/podcast/{t}/my-book/001.mp3", headers={"Range": "bytes=0-9"})
    assert r.status_code == 206 and r.headers["content-type"] == "audio/mpeg"
    assert c.get(f"/podcast/{'x' * 32}/feed.xml").status_code == 404
    assert c.get(f"/podcast/{t}/my-book/book.json").status_code == 404
    assert c.get(f"/podcast/{t}/..%2F..%2Ftok/001.mp3").status_code == 404


def test_podcast_bypasses_access_but_needs_token(tmp_path):
    s = _lib(tmp_path)
    s = Settings(**{**s.__dict__, "require_access_header": True, "access_team": "x", "access_aud": "y",
                    "access_email": "o@example.com"})
    c = TestClient(create_app(s))
    assert c.get("/api/panels").status_code == 403
    assert c.get(f"/podcast/{'t' * 32}/feed.xml").status_code == 200
    assert c.get("/podcast/wrong/feed.xml").status_code == 404


def test_no_token_file_means_no_feed(tmp_path):
    s = _lib(tmp_path)
    (tmp_path / "tok").unlink()
    assert TestClient(create_app(s)).get(f"/podcast/{'t' * 32}/feed.xml").status_code == 404


def test_untitled_sections_get_part_numbers():
    eps = ab.plan_episodes([("", "Words here. " * 5000)], "en")
    assert [e["title"] for e in eps] == ["Part 1", "Part 2", "Part 3"]




def test_books_and_research_feeds_are_separate(tmp_path):
    s = _lib(tmp_path)
    root = s.audiobook_root
    d = root / "library" / "papers"; d.mkdir()
    (d / "001.mp3").write_bytes(b"ID3" + b"p" * 10)
    (d / "book.json").write_text(json.dumps({"title": "Paper briefs", "added": "2026-11-15T11:00:00+00:00",
                                              "chapters": [{"n": 1, "title": "Lilo", "file": "001.mp3", "bytes": 13}]}))
    (tmp_path / "tok_research").write_text("r" * 32)
    c = TestClient(create_app(s))
    t, r = "t" * 32, "r" * 32
    books = c.get(f"/podcast/{t}/feed.xml").text
    research = c.get(f"/podcast/{r}/feed.xml").text
    assert "the user&apos;s Audiobooks" in books or "the user's Audiobooks" in books
    assert "My &lt;Book&gt;" in books and "Lilo" not in books
    assert "Research Briefs" in research and "Lilo" in research and "My &lt;Book&gt;" not in research
    assert c.get(f"/podcast/{r}/papers/001.mp3").status_code == 200
    assert c.get(f"/podcast/{r}/my-book/001.mp3").status_code == 404  # research token can't open books
    assert c.get(f"/podcast/{t}/papers/001.mp3").status_code == 404


def test_per_book_feed_and_overview(tmp_path):
    s = _lib(tmp_path)
    (tmp_path / "tok_research").write_text("r" * 32)
    c = TestClient(create_app(s))
    t, r = "t" * 32, "r" * 32
    x = c.get(f"/podcast/{t}/book/my-book.xml")
    assert x.status_code == 200 and "<channel><title>My &lt;Book&gt;</title>" in x.text
    assert "<itunes:author>A. Writer</itunes:author>" in x.text and "· 01 One" in x.text
    assert c.get(f"/podcast/{r}/book/my-book.xml").status_code == 404  # wrong feed's token
    assert c.get(f"/podcast/{t}/book/nope.xml").status_code == 404
    o = c.get("/api/audiobooks").json()
    assert o["feeds"]["books"] == f"https://research.example.com/podcast/{t}/feed.xml"
    assert o["feeds"]["research"] == f"https://research.example.com/podcast/{r}/feed.xml"
    [b] = o["books"]
    assert b["title"] == "My <Book>" and b["author"] == "A. Writer" and b["feed"] == "books"
    assert (b["episodes"], b["ready"], b["complete"]) == (2, 1, False) and b["hours"] == 1.0
    assert b["feed_url"] == f"https://research.example.com/podcast/{t}/book/my-book.xml"


def test_in_site_player_file_and_progress(tmp_path):
    c = TestClient(create_app(_lib(tmp_path)))
    o = c.get("/api/audiobooks").json()
    assert [ch["ready"] for ch in o["books"][0]["chapters"]] == [True, False]
    r = c.get("/api/audiobooks/file/my-book/001.mp3", headers={"Range": "bytes=0-4"})
    assert r.status_code == 206 and r.headers["content-type"] == "audio/mpeg"
    assert c.get("/api/audiobooks/file/my-book/002.mp3").status_code == 404  # not generated
    assert c.get("/api/audiobooks/progress").json() == {}
    assert c.post("/api/audiobooks/progress", json={"slug": "my-book", "file": "001.mp3", "pos": 42.26}).status_code == 200
    p = c.get("/api/audiobooks/progress").json()["my-book"]
    assert p["file"] == "001.mp3" and p["pos"] == 42.3
    assert c.post("/api/audiobooks/progress", json={"slug": "../x", "file": "001.mp3", "pos": 1}).status_code == 404
    assert c.post("/api/audiobooks/progress", json={"slug": "my-book", "file": "book.json", "pos": 1}).status_code == 404
