"""the user's books = their Zotero items of type "book", for the Audiobooks panel's searchable "My books" list.

The Mac exports the list (Research/tools/zotero_books_sync.py, cron every 10 min) to
<audiobook_root>/zotero_books.json. Zotero attachments sync to a WebDAV only the Mac can log in to,
so "Make audiobook" just drops a request in <audiobook_root>/requests/<zotero key>.json; the Mac's
next sync run sends that book's PDF/EPUB to inbox/ and starts backend/audiobook.py.
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

KEY = re.compile(r"^[A-Z0-9]{8}$")


def load(root: Path) -> dict:
    f = root / "zotero_books.json"
    try:
        data = json.loads(f.read_text())
        return {"books": data.get("books", []), "updated": int(f.stat().st_mtime)}
    except (OSError, ValueError):
        return {"books": [], "updated": 0}


def requests(root: Path) -> dict[str, dict]:
    """zotero key -> request ({"ts"} or {"error"} written back by the Mac)."""
    d = root / "requests"
    out = {}
    if d.is_dir():
        for f in d.glob("*.json"):
            try:
                out[f.stem] = json.loads(f.read_text() or "{}")
            except ValueError:
                out[f.stem] = {}
    return out


def request(root: Path, key: str) -> None:
    if not KEY.match(key):
        raise ValueError("bad key")
    d = root / "requests"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{key}.json").write_text(json.dumps({"ts": int(time.time())}))


FORMATS = {"pdf": "application/pdf", "epub": "application/epub+zip"}


def book_file(root: Path, key: str) -> Path | None:
    """The copy the Mac keeps in <audiobook_root>/books/<zotero key>.<pdf|epub> (books opened in the last 30 days)."""
    if not KEY.match(key):
        return None
    for ext in FORMATS:
        f = root / "books" / f"{key}.{ext}"
        if f.is_file():
            return f
    return None
