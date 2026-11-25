"""Daily Zotero -> Brain import (server side, Zotero web API; replaces the Mac-only local-sqlite extract + ingest).

What it does, idempotently:
  * lists every annotation and child note in the library with its version (`format=versions`, cheap);
  * fetches only new/changed ones, plus their attachment + parent item (title, type, creators, date, DOI, venue, tags);
  * one source node per Zotero parent item (zotero_items table remembers the mapping; on first sight an existing
    source node is matched by title, else a new `source:<slug>` node is created);
  * one highlights_full row per annotation / note, keyed by its Zotero key (highlights_full.zotero_key). Rows from the
    old Mac import have no key: an annotation first claims a matching keyless row (same source, page, text) instead of
    inserting a duplicate. A row whose annotation was deleted in Zotero is removed (guarded: not >30% of them at once);
  * never touches edges, non-source nodes, existing labels/details, or the owner's confirmations / notes / renames /
    answers. Source metadata (author, year, DOI, venue) is only filled in when empty.
Image/ink annotations: the web API has no rendered image; an existing screenshots/<key>.png (from the old Mac import)
is used, otherwise only the annotation's comment is kept.

CLI (jobs/brain_import.sh, daily):  python -m backend.brain_import [--db PATH]
"""
from __future__ import annotations

import argparse
import fcntl
import html
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

from .brain import Brain
from .zotero import ZoteroAPI, ZoteroError, load_config

SKIP_TAGS = {"notion"}
MAX_DELETE_SHARE = 0.30  # refuse to delete more than this share of keyed highlights at once...
MIN_DELETE_GUARD = 20  # ...when more than this many would go (small libraries can shrink freely)
COMMENT_ONLY = "[image/annotation]"
# The old Mac import's placeholder text for comment-only annotations (matched so its rows are claimed, not duplicated).
LEGACY_COMMENT_ONLY = "[\u56fe\u7247/\u6807\u6ce8]"


class ImportBusy(RuntimeError):
    pass


def strip_html(s: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", s or "")).strip()


def page_of(label) -> int:
    digits = re.sub(r"[^\d]", "", str(label or ""))
    try:
        return int(digits) if digits else 0
    except ValueError:
        return 0


def core_title(t: str) -> str:
    return re.split("[(\uff08]", t or "", maxsplit=1)[0].strip()


def slugify(t: str) -> str:
    t = re.sub(r"[^\w]+", "-", (t or "").lower()).strip("-")
    return t[:60] or "untitled"


def year_of(date: str) -> int | None:
    m = re.search(r"\b(19|20)\d{2}\b", date or "")
    return int(m.group(0)) if m else None


def first_author(creators) -> str | None:
    for c in creators or []:
        if c.get("lastName") or c.get("firstName"):
            return (c.get("lastName") or "") + (f", {c['firstName']}" if c.get("firstName") else "")
        if c.get("name"):
            return c["name"]
    return None


class ZoteroReader:
    """The few web-API reads the import needs (wraps backend.zotero.ZoteroAPI)."""

    def __init__(self, api: ZoteroAPI):
        self.api = api

    def versions(self, item_type: str) -> dict[str, int]:
        st, _, data = self.api.call("GET", f"/items?itemType={item_type}&format=versions")
        if st != 200 or not isinstance(data, dict):
            raise ZoteroError(f"listing {item_type} items failed (HTTP {st})")
        return {k: int(v) for k, v in data.items()}

    def items(self, keys: list[str]) -> list[dict]:
        out = []
        for i in range(0, len(keys), 50):
            chunk = keys[i:i + 50]
            st, _, data = self.api.call("GET", f"/items?itemKey={','.join(chunk)}&limit=50&includeTrashed=0")
            if st != 200 or not isinstance(data, list):
                raise ZoteroError(f"fetching items failed (HTTP {st})")
            out.extend(x.get("data", x) for x in data)
        return out


class Importer:
    def __init__(self, brain: Brain, reader: ZoteroReader, log=print):
        self.brain = brain
        self.z = reader
        self.log = log

    # ---- Zotero side -----------------------------------------------------------------------------------------
    def _fetch(self, seen: dict[str, int]) -> tuple[dict[str, int], list[dict], dict[str, dict]]:
        listing = {**self.z.versions("annotation"), **self.z.versions("note")}
        changed = sorted(k for k, v in listing.items() if seen.get(k) != v)
        items = self.z.items(changed) if changed else []
        # attachments -> parents, both cached for this run
        meta: dict[str, dict] = {}
        need = {x.get("parentItem") for x in items if x.get("parentItem")}
        for _ in range(2):  # annotation -> attachment -> parent item
            need -= set(meta)
            if not need:
                break
            got = self.z.items(sorted(need))
            meta.update({g["key"]: g for g in got if g.get("key")})
            need = {g.get("parentItem") for g in got if g.get("itemType") == "attachment" and g.get("parentItem")}
        return listing, items, meta

    @staticmethod
    def _top(key: str | None, meta: dict[str, dict]) -> dict | None:
        """The top-level item an annotation/note belongs to."""
        x = meta.get(key or "")
        if x and x.get("itemType") == "attachment" and x.get("parentItem") in meta:
            return meta[x["parentItem"]]
        return x

    def _row(self, x: dict) -> dict | None:
        """Zotero annotation/note -> highlights_full fields (None = nothing worth keeping)."""
        if x.get("itemType") == "note":
            text = strip_html(x.get("note", ""))
            if not text or "readingTime" in (x.get("note") or ""):
                return None
            return {"page": 0, "text": text[:3000], "color": None, "yue_comment": None, "annotation_type": "standalone_note",
                    "image_path": None, "is_standalone_note": 1, "highlighted_at": x.get("dateModified")}
        kind = x.get("annotationType") or "other"
        text = (x.get("annotationText") or "").replace("\n", " ").strip()
        comment = (x.get("annotationComment") or "").strip() or None
        image = None
        if kind in ("image", "ink") and (self.brain.screenshots / f"{x['key']}.png").is_file():
            image = f"screenshots/{x['key']}.png"
        if not text and not image:
            if not comment:
                return None
            text = COMMENT_ONLY
        return {"page": page_of(x.get("annotationPageLabel")), "text": text, "color": x.get("annotationColor"),
                "yue_comment": comment, "annotation_type": kind, "image_path": image, "is_standalone_note": 0,
                "highlighted_at": x.get("dateModified")}

    # ---- brain side --------------------------------------------------------------------------------------------
    @staticmethod
    def _source(conn, item: dict, stats: dict) -> str:
        key = item["key"]
        row = conn.execute("SELECT z.node_id FROM zotero_items z JOIN nodes n ON n.id = z.node_id WHERE z.item_key=?",
                           (key,)).fetchone()
        title = (item.get("title") or "Untitled").strip()
        if row:
            nid = row[0]
        else:
            short, core = title[:60], core_title(title)
            row = conn.execute("SELECT id FROM nodes WHERE type='source' AND label=? LIMIT 1", (short,)).fetchone()
            if not row and len(core) >= 4:
                row = conn.execute("SELECT id FROM nodes WHERE type='source' AND label LIKE ? LIMIT 1",
                                   (f"{core}%",)).fetchone()
            if not row:
                row = conn.execute("SELECT id FROM nodes WHERE type='source' AND label LIKE ? LIMIT 1",
                                   (f"%{short[:30]}%",)).fetchone()
            if row:
                nid = row[0]
            else:
                subtype = "book" if "book" in (item.get("itemType") or "").lower() else "paper"
                base = f"source:{slugify(core or title)}"
                nid, i = base, 0
                while conn.execute("SELECT 1 FROM nodes WHERE id=?", (nid,)).fetchone():
                    i += 1
                    nid = f"{base}-{i}"
                conn.execute("INSERT INTO nodes (id, type, subtype, label, detail, is_data_confirmed, is_ai_generated) "
                             "VALUES (?, 'source', ?, ?, ?, 0, 1)", (nid, subtype, short, subtype))
                stats["new_sources"] += 1
            conn.execute("INSERT OR REPLACE INTO zotero_items (item_key, node_id) VALUES (?, ?)", (key, nid))
        doi = (item.get("DOI") or "").strip() or None
        if not doi:
            m = re.search(r"(10\.\d{4,}/[\w./\-]+)", item.get("url") or "")
            doi = m.group(1) if m else None
        conn.execute("""UPDATE nodes SET author = COALESCE(author, ?), year = COALESCE(year, ?), doi = COALESCE(doi, ?),
                        venue = COALESCE(venue, ?) WHERE id=?""",
                     (first_author(item.get("creators")), year_of(item.get("date") or ""), doi,
                      (item.get("publicationTitle") or "").strip() or None, nid))
        tags = [t["tag"] for t in item.get("tags") or [] if t.get("tag") and t["tag"] not in SKIP_TAGS]
        if tags:
            conn.execute("UPDATE nodes SET zotero_tags=? WHERE id=?", (json.dumps(sorted(tags), ensure_ascii=False), nid))
        return nid

    @staticmethod
    def _claim_legacy(conn, src: str, key: str, r: dict) -> int | None:
        """A keyless row from the old import that is this annotation."""
        if r["image_path"]:
            row = conn.execute("SELECT id FROM highlights_full WHERE zotero_key IS NULL AND image_path=? LIMIT 1",
                               (r["image_path"],)).fetchone()
            if row:
                return row[0]
        texts = [r["text"]] + ([LEGACY_COMMENT_ONLY] if r["text"] == COMMENT_ONLY else [])
        for t in texts:
            row = conn.execute("SELECT id FROM highlights_full WHERE zotero_key IS NULL AND source_id=? AND page IS ? "
                               "AND text=? ORDER BY id LIMIT 1", (src, r["page"], t)).fetchone()
            if row:
                return row[0]
        return None

    def run(self) -> dict:
        """One import. Raises ImportBusy if another import holds the lock."""
        self.brain.ensure_schema()
        lock = open(self.brain.path.with_name(".brain_import.lock"), "w")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            lock.close()
            raise ImportBusy("an import is already running")
        try:
            return self._run()
        finally:
            lock.close()

    def _run(self) -> dict:
        started = time.time()
        with self.brain.db() as conn:
            seen = {k: v for k, v in conn.execute("SELECT key, version FROM zotero_seen")}
        listing, items, meta = self._fetch(seen)  # network outside any DB transaction
        stats = {"first_import": not seen, "new_highlights": 0, "new_comments": 0, "new_sources": 0, "updated": 0, "claimed": 0, "removed": 0,
                 "skipped": 0, "fetched": len(items)}
        with self.brain.db(write=True) as conn:
            touched: set[str] = set()
            # annotations first, so notes can tell whether their item has any (as the old import did)
            for x in sorted(items, key=lambda i: i.get("itemType") == "note"):
                key, ver = x.get("key"), x.get("version", listing.get(x.get("key"), 0))
                if not key:
                    continue
                conn.execute("INSERT OR REPLACE INTO zotero_seen (key, version, kind) VALUES (?, ?, ?)",
                             (key, int(listing.get(key, ver) or 0), x.get("itemType") or "?"))
                r = self._row(x)
                top = self._top(x.get("parentItem"), meta)
                existing = conn.execute("SELECT id FROM highlights_full WHERE zotero_key=?", (key,)).fetchone()
                if r is None or top is None:
                    if existing:
                        conn.execute("DELETE FROM highlights_full WHERE id=?", (existing[0],))
                        stats["removed"] += 1
                    stats["skipped"] += 1
                    continue
                if x.get("itemType") == "note":
                    has_item = conn.execute("SELECT 1 FROM zotero_items WHERE item_key=?", (top["key"],)).fetchone()
                    if not has_item:  # retried next run, in case the item gets highlights later
                        conn.execute("DELETE FROM zotero_seen WHERE key=?", (key,))
                        stats["skipped"] += 1
                        continue
                src = self._source(conn, top, stats)
                touched.add(src)
                vals = (src, r["page"], r["text"], r["color"], r["yue_comment"], r["highlighted_at"],
                        r["annotation_type"], r["image_path"], r["is_standalone_note"])
                rid = existing[0] if existing else self._claim_legacy(conn, src, key, r)
                if rid is not None:
                    conn.execute("""UPDATE highlights_full SET source_id=?, page=?, text=?, color=?, yue_comment=?,
                                    highlighted_at=?, annotation_type=?, image_path=?, is_standalone_note=?, zotero_key=?
                                    WHERE id=?""", (*vals, key, rid))
                    stats["updated" if existing else "claimed"] += 1
                    continue
                dup = conn.execute("SELECT 1 FROM highlights_full WHERE source_id=? AND page IS ? AND substr(text,1,30)=? "
                                   "LIMIT 1", (src, r["page"], r["text"][:30])).fetchone()
                if dup and r["text"] != COMMENT_ONLY and not r["image_path"]:
                    stats["skipped"] += 1  # same passage highlighted twice (the old import kept one too)
                    continue
                conn.execute("""INSERT INTO highlights_full (source_id, page, text, color, yue_comment, highlighted_at,
                                annotation_type, image_path, is_standalone_note, zotero_key)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""", (*vals, key))
                stats["new_highlights"] += 1
                if r["yue_comment"]:
                    stats["new_comments"] += 1
            # deletions in Zotero
            gone = [k for k in seen if k not in listing]
            keyed = conn.execute("SELECT COUNT(*) FROM highlights_full WHERE zotero_key IS NOT NULL").fetchone()[0]
            doomed = [k for k in gone if conn.execute("SELECT 1 FROM highlights_full WHERE zotero_key=?", (k,)).fetchone()]
            if len(doomed) > MIN_DELETE_GUARD and len(doomed) > MAX_DELETE_SHARE * keyed:
                stats["delete_guard"] = f"{len(doomed)} of {keyed} highlights gone from Zotero - not deleting"
            else:
                for k in gone:
                    for (sid,) in conn.execute("SELECT source_id FROM highlights_full WHERE zotero_key=?", (k,)).fetchall():
                        touched.add(sid)
                    stats["removed"] += conn.execute("DELETE FROM highlights_full WHERE zotero_key=?", (k,)).rowcount
                    conn.execute("DELETE FROM zotero_seen WHERE key=?", (k,))
            for sid in touched:
                conn.execute("UPDATE nodes SET highlights_count = (SELECT COUNT(*) FROM highlights_full WHERE source_id=?) "
                             "WHERE id=?", (sid, sid))
            stats["legacy_unkeyed"] = conn.execute("SELECT COUNT(*) FROM highlights_full WHERE zotero_key IS NULL").fetchone()[0]
            stats["seconds"] = round(time.time() - started, 1)
            stats["timestamp"] = datetime.now().astimezone().isoformat(timespec="seconds")
            conn.execute("INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('last_import', ?, CURRENT_TIMESTAMP)",
                         (json.dumps(stats),))
            conn.execute("INSERT INTO actions_log (action, target_type, target_id, after_state) VALUES "
                         "('zotero_import', 'db', 'all', ?)", (json.dumps(stats),))
        self.log(f"brain import: {json.dumps(stats)}")
        return stats


def default_db() -> Path:
    if os.environ.get("RP_BRAIN_DB"):
        return Path(os.environ["RP_BRAIN_DB"])
    root = Path(os.environ.get("RP_RESEARCH_ROOT") or Path.home() / "Research")
    return root / "reading_log" / "brain" / "brain.db"


def importer_for(brain: Brain, zotero_file: Path | None, log=print) -> Importer | None:
    cfg = load_config(zotero_file)
    return Importer(brain, ZoteroReader(ZoteroAPI(cfg["user_id"], cfg["api_key"])), log) if cfg else None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--db", type=Path, default=None)
    a = ap.parse_args(argv)
    zfile = Path(os.environ.get("RP_ZOTERO_FILE") or Path.home() / ".config/research-platform/zotero.json")
    imp = importer_for(Brain(a.db or default_db()), zfile)
    if imp is None:
        print(f"Zotero not configured ({zfile})", file=sys.stderr)
        return 2
    try:
        imp.run()
    except (ZoteroError, ImportBusy) as exc:
        print(f"brain import failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
