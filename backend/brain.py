"""Brain panel: a 3D concept map of what the owner reads (sources, highlights, concepts, questions, projects).

Store: one SQLite file, <Research>/reading_log/brain/brain.db (override with RP_BRAIN_DB). The platform is its only
writer. Two kinds of tables:
  * content  - nodes, edges, domains, node_domains, highlights_full (Zotero highlights/notes, refreshed daily by
               backend/brain_import.py), agent_messages (the "ask AI" chats per node);
  * the owner's own work, never touched by an import - node_confirmations, edge_confirmations, node_notes,
    node_renames, answers (and actions_log, an audit trail of every change).
Screenshots of image annotations live next to the DB in screenshots/<annotation key>.png.

The UI (frontend/public/brain/) calls the /api/brain/... routes in app.py, which call the methods here.
"Ask AI" and "extract from paste" use Gemini over its REST API when GEMINI_API_KEY is set (no SDK needed).
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('source','concept','project','question','highlight','comment')),
  subtype TEXT,
  label TEXT NOT NULL,
  detail TEXT,
  author TEXT,
  year INTEGER,
  doi TEXT,
  venue TEXT,
  page INTEGER,
  weight INTEGER,
  highlights_count INTEGER,
  yue_comment TEXT,
  source_id TEXT,
  is_data_confirmed INTEGER DEFAULT 0,
  is_ai_generated INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  zotero_tags TEXT,
  FOREIGN KEY(source_id) REFERENCES nodes(id)
);
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_nodes_source ON nodes(source_id);
CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  label TEXT,
  is_data_confirmed INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source_node_id, target_node_id, edge_type),
  FOREIGN KEY(source_node_id) REFERENCES nodes(id),
  FOREIGN KEY(target_node_id) REFERENCES nodes(id)
);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_node_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_node_id);
CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(edge_type);
CREATE TABLE IF NOT EXISTS highlights_full (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  page INTEGER,
  text TEXT NOT NULL,
  color TEXT,
  yue_comment TEXT,
  zotero_key TEXT,
  highlighted_at TEXT,
  annotation_type TEXT,
  image_path TEXT,
  is_standalone_note INTEGER DEFAULT 0,
  FOREIGN KEY(source_id) REFERENCES nodes(id)
);
CREATE INDEX IF NOT EXISTS idx_hl_source ON highlights_full(source_id);
CREATE TABLE IF NOT EXISTS domains (id TEXT PRIMARY KEY, label TEXT NOT NULL, color TEXT);
CREATE TABLE IF NOT EXISTS node_domains (
  node_id TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  PRIMARY KEY (node_id, domain_id),
  FOREIGN KEY(node_id) REFERENCES nodes(id),
  FOREIGN KEY(domain_id) REFERENCES domains(id)
);
CREATE TABLE IF NOT EXISTS node_confirmations (
  node_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('confirmed','rejected')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(node_id) REFERENCES nodes(id)
);
CREATE TABLE IF NOT EXISTS edge_confirmations (
  edge_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('confirmed','rejected')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(edge_id) REFERENCES edges(id)
);
CREATE TABLE IF NOT EXISTS node_notes (
  node_id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(node_id) REFERENCES nodes(id)
);
CREATE TABLE IF NOT EXISTS node_renames (
  node_id TEXT PRIMARY KEY,
  custom_label TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(node_id) REFERENCES nodes(id)
);
CREATE TABLE IF NOT EXISTS answers (
  question_id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(question_id) REFERENCES nodes(id)
);
CREATE TABLE IF NOT EXISTS actions_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  before_state TEXT,
  after_state TEXT
);
CREATE INDEX IF NOT EXISTS idx_log_ts ON actions_log(ts);
CREATE INDEX IF NOT EXISTS idx_log_target ON actions_log(target_type, target_id);
CREATE TABLE IF NOT EXISTS agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (node_id) REFERENCES nodes(id)
);
CREATE INDEX IF NOT EXISTS idx_agent_msg_node ON agent_messages(node_id, id);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
-- Zotero import bookkeeping (backend/brain_import.py)
CREATE TABLE IF NOT EXISTS zotero_items (item_key TEXT PRIMARY KEY, node_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS zotero_seen (key TEXT PRIMARY KEY, version INTEGER NOT NULL, kind TEXT NOT NULL);
"""
# Columns added to older brain.db files after their tables were created.
LATE_COLUMNS = {
    "nodes": [("zotero_tags", "TEXT")],
    "highlights_full": [("annotation_type", "TEXT"), ("image_path", "TEXT"), ("is_standalone_note", "INTEGER DEFAULT 0")],
}

NODE_TYPES = ("source", "concept", "project", "question", "highlight", "comment")
SCREENSHOT = re.compile(r"^[A-Za-z0-9_-]{1,64}\.png$")
# Label tokens for "related" search: split on spaces and common (incl. full-width) punctuation.
SPLIT = re.compile(r"[\s/\u00b7()\uff08\uff09,\uff0c\u3002\-\uff1a:\u3001\u2018\u2019]+")

GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models"
ANSWER_LANGUAGE = "the language of the question"

EXPLAIN_PROMPT = """You are the assistant inside the user's "second brain", a concept map of what they read.
Their research projects (project nodes in the map):
{projects}

They clicked a node and may not remember what it means, or want to know more. Bring them back to the context in
which they read it and point out possible links to their research and interests.

[This node]
{node_summary}

[Its neighbours in the map]
{neighbors_summary}

[Related sources and highlighted passages]
{highlights}

Style:
- Answer in {language}; concise, 2-4 short paragraphs, at most ~250 words
- First answer: what it is + where it comes from + which project it relates to
- Follow-up questions: answer the question; this is a conversation, you may refer to earlier turns
- If the user wrote a comment on a highlight, quote it
- If you are unsure where it comes from, say honestly that it is an AI guess
- No filler, don't repeat the question
"""
DEFAULT_QUESTION = "What does this mean? Why is it in my map? How might it relate to my research?"

EXTRACT_PROMPT = """You turn a pasted piece of text (notes, an email, a document, a passing thought) into structured
entries for the user's concept map. Return three lists:

1. concepts - new concept nodes worth keeping (the "thing" they will think about or cite again)
   - label: short (2-8 words); detail: one paragraph (why they care / how it relates to a project)
   - domains: 0-3 of: {domains}
2. questions - open questions to answer later (ending with a question mark)
   - label: the question itself; detail: background / why it is asked
3. comments - reactions to EXISTING nodes (not new concepts, but a concrete thought about an existing concept/source)
   - text: the full thought; attach_to: the id of an existing node (must come from the list below)

Leave a list empty if the text has nothing of that kind. Never invent an attach_to id: use ids from this list only.

Existing nodes ({count}):
{existing}
"""
EXTRACT_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "concepts": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
            "label": {"type": "STRING"}, "detail": {"type": "STRING"},
            "domains": {"type": "ARRAY", "items": {"type": "STRING"}}}, "required": ["label"]}},
        "questions": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
            "label": {"type": "STRING"}, "detail": {"type": "STRING"}}, "required": ["label"]}},
        "comments": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
            "text": {"type": "STRING"}, "attach_to": {"type": "STRING"}}, "required": ["text", "attach_to"]}},
    },
}


class BrainError(ValueError):
    """A bad request (400)."""


class NotFound(KeyError):
    """Unknown node / edge (404)."""


class AINotConfigured(RuntimeError):
    """No GEMINI_API_KEY (503)."""


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _dumps(x) -> str | None:
    return None if x is None else json.dumps(x, ensure_ascii=False)


def _hl(row) -> dict:
    """highlights_full row (page, text, yue_comment, annotation_type, image_path, is_standalone_note) -> UI dict."""
    d = {"page": row[0], "text": row[1]}
    if row[2]:
        d["yue_comment"] = row[2]
    if row[3]:
        d["annotation_type"] = row[3]
    if row[4]:
        d["image_path"] = row[4]
    if row[5]:
        d["is_standalone_note"] = True
    return d


def label_terms(label: str) -> set[str]:
    terms = {label.lower()} if label else set()
    for w in SPLIT.split(label or ""):
        if len(w) >= 2:
            terms.add(w.lower())
    return terms


class Brain:
    def __init__(self, db_path: Path, gemini_key: str | None = None, gemini_model: str | None = None, opener=None):
        self.path = Path(db_path)
        self.dir = self.path.parent
        self.screenshots = self.dir / "screenshots"
        self.gemini_key = gemini_key if gemini_key is not None else (
            os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or None)
        self.gemini_model = gemini_model or os.environ.get("GEMINI_MODEL") or "gemini-2.5-flash"
        self.opener = opener or urllib.request.urlopen
        self._lock = threading.Lock()  # one writer at a time inside this process
        self._ready = False

    # ---- connection ----------------------------------------------------------------------------------------
    def exists(self) -> bool:
        return self.path.is_file()

    def _open(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.path), timeout=10.0)
        conn.execute("PRAGMA busy_timeout = 10000")
        conn.execute("PRAGMA foreign_keys = ON")
        conn.row_factory = sqlite3.Row
        return conn

    def ensure_schema(self) -> None:
        """Create missing tables/columns. Rollback-journal mode (not WAL): the file sits in a Nextcloud-synced folder,
        and with WAL a copy of brain.db alone can miss committed changes."""
        if self._ready:
            return
        self.dir.mkdir(parents=True, exist_ok=True)
        conn = self._open()
        try:
            if conn.execute("PRAGMA journal_mode").fetchone()[0].lower() != "delete":
                conn.execute("PRAGMA journal_mode = DELETE")
            conn.executescript(SCHEMA)
            for table, cols in LATE_COLUMNS.items():
                have = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
                for name, decl in cols:
                    if name not in have:
                        conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_hl_zkey ON highlights_full(zotero_key)")
            conn.execute("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')")
            conn.commit()
        finally:
            conn.close()
        self._ready = True

    @contextmanager
    def db(self, write: bool = False) -> Iterator[sqlite3.Connection]:
        """One connection per call. Writes are serialised in-process and run in one transaction."""
        if write or self.exists():
            self.ensure_schema()
        if not write:
            if not self.exists():
                raise FileNotFoundError(str(self.path))
            conn = self._open()
            try:
                yield conn
            finally:
                conn.close()
            return
        with self._lock:
            conn = self._open()
            try:
                yield conn
                conn.commit()
            except BaseException:
                conn.rollback()
                raise
            finally:
                conn.close()

    @staticmethod
    def log_action(conn, action: str, target_type: str, target_id: str, before, after) -> None:
        conn.execute("INSERT INTO actions_log (action, target_type, target_id, before_state, after_state) "
                     "VALUES (?, ?, ?, ?, ?)", (action, target_type, target_id, _dumps(before), _dumps(after)))

    @staticmethod
    def _need_node(conn, node_id: str, type_: str | None = None) -> sqlite3.Row:
        row = conn.execute("SELECT * FROM nodes WHERE id=?", (node_id,)).fetchone()
        if not row or (type_ and row["type"] != type_):
            raise NotFound(f"{type_ or 'node'} {node_id} not found")
        return row

    # ---- reads -----------------------------------------------------------------------------------------------
    def graph(self) -> dict:
        if not self.exists():
            return {"meta": {"domains": [], "schema_version": 1}, "nodes": [], "links": []}
        with self.db() as conn:
            doms: dict[str, list[str]] = {}
            for nid, dom in conn.execute("SELECT node_id, domain_id FROM node_domains"):
                doms.setdefault(nid, []).append(dom)
            top: dict[str, list[dict]] = {}
            # Sources carry only their top 6 highlights (commented first); the full list is loaded on demand.
            for r in conn.execute("""
                SELECT source_id, page, text, yue_comment, annotation_type, image_path, is_standalone_note FROM (
                  SELECT h.*, ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY (yue_comment IS NULL), page, id) AS rn
                  FROM highlights_full h) WHERE rn <= 6"""):
                top.setdefault(r[0], []).append(_hl(tuple(r)[1:]))
            nodes = []
            for n in conn.execute("SELECT * FROM nodes"):
                out = {"id": n["id"], "type": n["type"], "label": n["label"]}
                for k in ("subtype", "detail", "author", "year", "doi", "venue", "page", "weight", "highlights_count",
                          "yue_comment"):
                    if n[k]:
                        out[k] = n[k]
                if n["is_data_confirmed"]:
                    out["confirmed"] = True
                if n["zotero_tags"]:
                    try:
                        tags = json.loads(n["zotero_tags"])
                        if isinstance(tags, list) and tags:
                            out["zotero_tags"] = tags
                    except ValueError:
                        pass
                if n["id"] in doms:
                    out["domains"] = doms[n["id"]]
                if n["type"] == "source" and n["id"] in top:
                    out["highlights"] = top[n["id"]]
                nodes.append(out)
            links = []
            for e in conn.execute("SELECT id, source_node_id, target_node_id, edge_type, label, is_data_confirmed FROM edges"):
                link = {"id": e[0], "source": e[1], "target": e[2], "type": e[3]}
                if e[4]:
                    link["label"] = e[4]
                if e[5]:
                    link["confirmed"] = True
                links.append(link)
            counts = {d: c for d, c in conn.execute("SELECT domain_id, COUNT(*) FROM node_domains GROUP BY domain_id")}
            domains = [{"id": d[0], "label": d[1], "color": d[2], "count": counts.get(d[0], 0)}
                       for d in conn.execute("SELECT id, label, color FROM domains")]
            domains.sort(key=lambda d: -d["count"])
        return {"meta": {"domains": domains, "schema_version": 1}, "nodes": nodes, "links": links}

    def state(self) -> dict:
        st: dict = {"node_confirmations": {}, "edge_confirmations": {}, "node_notes": {}, "node_renames": {}, "answers": {}}
        if not self.exists():
            return st
        with self.db() as conn:
            st["node_confirmations"] = {r[0]: r[1] for r in conn.execute("SELECT node_id, status FROM node_confirmations")}
            st["edge_confirmations"] = {str(r[0]): r[1] for r in conn.execute("SELECT edge_id, status FROM edge_confirmations")}
            st["node_notes"] = {r[0]: {"text": r[1], "updated": r[2]}
                                for r in conn.execute("SELECT node_id, text, updated_at FROM node_notes")}
            st["node_renames"] = {r[0]: r[1] for r in conn.execute("SELECT node_id, custom_label FROM node_renames")}
            st["answers"] = {r[0]: r[1] for r in conn.execute("SELECT question_id, text FROM answers")}
        return st

    def highlights(self, node_id: str) -> list[dict]:
        with self.db() as conn:
            rows = conn.execute("""SELECT page, text, yue_comment, annotation_type, image_path, is_standalone_note
                                   FROM highlights_full WHERE source_id=? ORDER BY (yue_comment IS NULL), page, id""",
                                (node_id,)).fetchall()
        return [_hl(tuple(r)) for r in rows]

    def messages(self, node_id: str) -> list[dict]:
        with self.db() as conn:
            rows = conn.execute("SELECT role, content, created_at FROM agent_messages WHERE node_id=? ORDER BY id",
                                (node_id,)).fetchall()
        return [{"role": r[0], "content": r[1], "at": r[2]} for r in rows]

    def context(self, node_id: str, max_depth: int = 2, max_sources: int = 4, per_source: int = 4) -> list[dict]:
        """Sources within 2 hops of the node, each with the highlights that mention the node's label words
        (falling back to the source's commented highlights), so every concept shows its own provenance."""
        with self.db() as conn:
            n = self._need_node(conn, node_id)
            terms = label_terms((n["label"] or "").strip())
            visited, queue, found = {node_id}, [(node_id, 0)], []
            while queue:
                cur, depth = queue.pop(0)
                if depth >= max_depth:
                    continue
                for s, t in conn.execute("SELECT source_node_id, target_node_id FROM edges "
                                         "WHERE source_node_id=? OR target_node_id=?", (cur, cur)).fetchall():
                    other = t if s == cur else s
                    if other in visited:
                        continue
                    visited.add(other)
                    row = conn.execute("SELECT type, subtype, label FROM nodes WHERE id=?", (other,)).fetchone()
                    if not row:
                        continue
                    if row[0] == "source":
                        found.append({"id": other, "label": row[2], "subtype": row[1], "hops": depth + 1})
                    else:
                        queue.append((other, depth + 1))
            found.sort(key=lambda s: s["hops"])
            out = []
            for s in found[:max_sources]:
                hls: list[dict] = []
                if terms:
                    clause = " OR ".join(["text LIKE ?"] * len(terms) + ["yue_comment LIKE ?"] * len(terms))
                    likes = [f"%{t}%" for t in terms] * 2
                    for r in conn.execute(f"SELECT page, text, yue_comment FROM highlights_full WHERE source_id=? "
                                          f"AND ({clause}) ORDER BY (yue_comment IS NULL), page LIMIT ?",
                                          [s["id"], *likes, per_source]):
                        hls.append({"page": r[0], "text": r[1], "yue_comment": r[2]})
                if len(hls) < 2:
                    pages = {h["page"] for h in hls}
                    for r in conn.execute("SELECT page, text, yue_comment FROM highlights_full WHERE source_id=? "
                                          "ORDER BY (yue_comment IS NULL), page LIMIT ?",
                                          (s["id"], (per_source - len(hls)) * 2)):
                        if r[0] in pages:
                            continue
                        hls.append({"page": r[0], "text": r[1], "yue_comment": r[2]})
                        if len(hls) >= per_source:
                            break
                if hls:
                    out.append({"source": {"id": s["id"], "label": s["label"], "subtype": s["subtype"]},
                                "hops": s["hops"], "highlights": hls})
        return out

    def discover(self, node_id: str, limit: int = 20) -> list[dict]:
        """Nodes (or sources via their highlights) whose text mentions this node's label words, not yet linked."""
        with self.db() as conn:
            n = self._need_node(conn, node_id)
            label = (n["label"] or "").strip()
            terms = label_terms(label) | ({label} if label else set())
            by_id: dict[str, dict] = {}

            def entry(r) -> dict:
                return by_id.setdefault(r[0], {"id": r[0], "type": r[1], "subtype": r[2], "label": r[3],
                                               "matched_terms": set(), "match_count": 0, "snippet": None})

            def snip(text: str, term: str, prefix: str = "") -> str | None:
                i = text.lower().find(term.lower())
                if i < 0:
                    return None
                a, b = max(0, i - 30), min(len(text), i + len(term) + 50)
                return prefix + ("…" if a > 0 else "") + text[a:b] + ("…" if b < len(text) else "")

            for term in terms:
                like = f"%{term}%"
                for r in conn.execute("SELECT id, type, subtype, label, detail FROM nodes WHERE id != ? AND "
                                      "(label LIKE ? OR detail LIKE ? OR yue_comment LIKE ?) LIMIT 40",
                                      (node_id, like, like, like)):
                    e = entry(r)
                    e["matched_terms"].add(term)
                    e["match_count"] += 1
                    if not e["snippet"] and r[4]:
                        e["snippet"] = snip(r[4], term)
                for r in conn.execute("SELECT n.id, n.type, n.subtype, n.label, h.page, h.text, h.yue_comment "
                                      "FROM highlights_full h JOIN nodes n ON h.source_id = n.id "
                                      "WHERE n.id != ? AND (h.text LIKE ? OR h.yue_comment LIKE ?) LIMIT 40",
                                      (node_id, like, like)):
                    e = entry(r)
                    e["matched_terms"].add(term)
                    e["match_count"] += 1
                    if not e["snippet"]:
                        e["snippet"] = snip(r[6] or r[5] or "", term, f"p.{r[4]} ")
            linked = {r[0] for r in conn.execute(
                "SELECT CASE WHEN source_node_id=? THEN target_node_id ELSE source_node_id END FROM edges "
                "WHERE source_node_id=? OR target_node_id=?", (node_id, node_id, node_id))}
        out = [dict(e, matched_terms=sorted(e["matched_terms"])) for e in by_id.values() if e["id"] not in linked]
        out.sort(key=lambda x: (-x["match_count"], x["label"] or ""))
        return out[:limit]

    def last_update(self) -> dict:
        empty = {"timestamp": None, "new_highlights": 0, "new_comments": 0, "new_sources": 0}
        if not self.exists():
            return empty
        with self.db() as conn:
            row = conn.execute("SELECT value FROM meta WHERE key='last_import'").fetchone()
        try:
            last = {**empty, **json.loads(row[0])} if row and row[0] else empty
        except ValueError:
            return empty
        if last.get("first_import"):  # the first run takes over the old import's rows: not "new reading"
            last.update(new_highlights=0, new_comments=0, new_sources=0)
        return last

    def screenshot(self, name: str) -> Path:
        if not SCREENSHOT.match(name):
            raise NotFound(name)
        f = self.screenshots / name
        if not f.is_file():
            raise NotFound(name)
        return f

    # ---- the owner's state ------------------------------------------------------------------------------------
    def _upsert(self, conn, table: str, key_col: str, val_col: str, key, value, action: str, target_type: str,
                what: str) -> None:
        before = conn.execute(f"SELECT {val_col} FROM {table} WHERE {key_col}=?", (key,)).fetchone()
        before = before[0] if before else None
        if value is None:
            conn.execute(f"DELETE FROM {table} WHERE {key_col}=?", (key,))
        else:
            conn.execute(f"INSERT INTO {table} ({key_col}, {val_col}, updated_at) VALUES (?, ?, ?) "
                         f"ON CONFLICT({key_col}) DO UPDATE SET {val_col}=excluded.{val_col}, "
                         f"updated_at=excluded.updated_at", (key, value, now_iso()))
        self.log_action(conn, action, target_type, str(key), {what: before}, {what: value})

    @staticmethod
    def _status(status) -> str | None:
        if status in (None, "", "pending"):
            return None
        if status not in ("confirmed", "rejected"):
            raise BrainError("status must be confirmed, rejected or pending")
        return status

    def confirm_node(self, node_id: str, status) -> None:
        st = self._status(status)
        with self.db(write=True) as conn:
            self._need_node(conn, node_id)
            self._upsert(conn, "node_confirmations", "node_id", "status", node_id, st, f"node_{st or 'pending'}",
                         "node", "status")

    def confirm_edge(self, edge_id: int, status) -> None:
        st = self._status(status)
        with self.db(write=True) as conn:
            if not conn.execute("SELECT 1 FROM edges WHERE id=?", (edge_id,)).fetchone():
                raise NotFound(f"edge {edge_id} not found")
            self._upsert(conn, "edge_confirmations", "edge_id", "status", edge_id, st, f"edge_{st or 'pending'}",
                         "edge", "status")

    def set_note(self, node_id: str, text: str | None) -> str:
        text = (text or "").strip()
        with self.db(write=True) as conn:
            self._need_node(conn, node_id)
            self._upsert(conn, "node_notes", "node_id", "text", node_id, text or None, "note_save", "node", "text")
        return text

    def rename(self, node_id: str, label: str | None) -> str:
        label = (label or "").strip()
        with self.db(write=True) as conn:
            self._need_node(conn, node_id)
            self._upsert(conn, "node_renames", "node_id", "custom_label", node_id, label or None, "rename", "node", "label")
        return label

    def set_answer(self, question_id: str, text: str | None) -> str:
        text = (text or "").strip()
        with self.db(write=True) as conn:
            self._need_node(conn, question_id, "question")
            self._upsert(conn, "answers", "question_id", "text", question_id, text or None, "answer_save", "question", "text")
        return text

    def set_detail(self, node_id: str, text: str | None) -> None:
        with self.db(write=True) as conn:
            before = self._need_node(conn, node_id)["detail"]
            text = (text or "").strip() or None
            conn.execute("UPDATE nodes SET detail=? WHERE id=?", (text, node_id))
            self.log_action(conn, "detail_edit", "node", node_id, {"detail": before}, {"detail": text})

    def set_type(self, node_id: str, new_type: str, subtype: str | None = None) -> None:
        if new_type not in NODE_TYPES:
            raise BrainError(f"invalid type: {new_type}")
        if new_type == "source":
            if subtype not in ("book", "paper"):
                raise BrainError("source requires subtype (book or paper)")
        else:
            subtype = None
        with self.db(write=True) as conn:
            row = self._need_node(conn, node_id)
            conn.execute("UPDATE nodes SET type=?, subtype=? WHERE id=?", (new_type, subtype, node_id))
            self.log_action(conn, "type_change", "node", node_id, {"type": row["type"], "subtype": row["subtype"]},
                            {"type": new_type, "subtype": subtype})

    def set_subtype(self, node_id: str, subtype: str | None) -> None:
        with self.db(write=True) as conn:
            row = self._need_node(conn, node_id)
            if row["type"] != "source":
                raise BrainError("only source nodes have a subtype")
            conn.execute("UPDATE nodes SET subtype=? WHERE id=?", (subtype, node_id))
            self.log_action(conn, "subtype_change", "node", node_id, {"subtype": row["subtype"]}, {"subtype": subtype})

    def set_domains(self, node_id: str, domains) -> None:
        if not isinstance(domains, list) or not all(isinstance(d, str) for d in domains):
            raise BrainError("domains must be a list of strings")
        with self.db(write=True) as conn:
            self._need_node(conn, node_id)
            before = [r[0] for r in conn.execute("SELECT domain_id FROM node_domains WHERE node_id=?", (node_id,))]
            conn.execute("DELETE FROM node_domains WHERE node_id=?", (node_id,))
            for d in domains:
                if d:
                    conn.execute("INSERT OR IGNORE INTO node_domains (node_id, domain_id) VALUES (?, ?)", (node_id, d))
            self.log_action(conn, "domains_edit", "node", node_id, {"domains": before}, {"domains": domains})

    def clear_messages(self, node_id: str) -> None:
        with self.db(write=True) as conn:
            conn.execute("DELETE FROM agent_messages WHERE node_id=?", (node_id,))

    # ---- creating / merging ---------------------------------------------------------------------------------------
    def create_node(self, node_type: str = "concept", label: str = "", detail: str | None = None, weight=None,
                    domains=None, subtype: str | None = None, author: str | None = None, year=None,
                    doi: str | None = None, venue: str | None = None) -> dict:
        """A node the owner made: always confirmed, never removed by an import."""
        if node_type not in ("concept", "question", "source", "comment"):
            raise BrainError(f"unsupported type for user creation: {node_type}")
        if node_type == "source" and subtype not in ("book", "paper"):
            raise BrainError("source requires subtype (book or paper)")
        label = (label or "").strip()
        if not label:
            raise BrainError("label required")
        if node_type != "source":
            subtype = None
        try:
            year_int = int(year) if year else None
        except (TypeError, ValueError):
            year_int = None
        with self.db(write=True) as conn:
            base = f"{node_type}:user-{int(time.time() * 1000)}"
            new_id, i = base, 0
            while conn.execute("SELECT 1 FROM nodes WHERE id=?", (new_id,)).fetchone():
                i += 1
                new_id = f"{base}-{i}"
            conn.execute("""INSERT INTO nodes (id, type, subtype, label, detail, weight, author, year, doi, venue,
                            is_data_confirmed, is_ai_generated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)""",
                         (new_id, node_type, subtype, label, detail or None, weight or 1, author or None, year_int,
                          doi or None, venue or None))
            for d in domains or []:
                if isinstance(d, str) and d:
                    conn.execute("INSERT OR IGNORE INTO node_domains (node_id, domain_id) VALUES (?, ?)", (new_id, d))
            self.log_action(conn, "node_create", "node", new_id, None,
                            {"type": node_type, "subtype": subtype, "label": label, "detail": detail,
                             "domains": domains, "author": author, "year": year, "doi": doi})
            row = conn.execute("SELECT * FROM nodes WHERE id=?", (new_id,)).fetchone()
            node = {"id": row["id"], "type": row["type"], "label": row["label"]}
            for k in ("subtype", "detail", "weight", "author", "year", "doi", "venue"):
                if row[k]:
                    node[k] = row[k]
            node["confirmed"] = True
            doms = [r[0] for r in conn.execute("SELECT domain_id FROM node_domains WHERE node_id=?", (new_id,))]
            if doms:
                node["domains"] = doms
        return node

    def create_edge(self, source: str, target: str, edge_type: str = "relates_to", label: str | None = None) -> dict:
        edge_type = (edge_type or "relates_to").strip()
        label = (label or "").strip() or None
        if not source or not target:
            raise BrainError("source and target required")
        if source == target:
            raise BrainError("source == target")
        with self.db(write=True) as conn:
            row = conn.execute("SELECT id FROM edges WHERE source_node_id=? AND target_node_id=? AND edge_type=?",
                               (source, target, edge_type)).fetchone()
            duplicate = bool(row)
            if not row:
                for nid in (source, target):
                    if not conn.execute("SELECT 1 FROM nodes WHERE id=?", (nid,)).fetchone():
                        raise BrainError(f"node {nid} not found")
                eid = conn.execute("INSERT INTO edges (source_node_id, target_node_id, edge_type, label, is_data_confirmed) "
                                   "VALUES (?, ?, ?, ?, 1)", (source, target, edge_type, label)).lastrowid
                self.log_action(conn, "edge_create", "edge", str(eid), None,
                                {"source": source, "target": target, "type": edge_type, "label": label})
            else:
                eid = row[0]
            e = conn.execute("SELECT id, source_node_id, target_node_id, edge_type, label, is_data_confirmed FROM edges "
                             "WHERE id=?", (eid,)).fetchone()
        edge = {"id": e[0], "source": e[1], "target": e[2], "type": e[3]}
        if e[4]:
            edge["label"] = e[4]
        if e[5]:
            edge["confirmed"] = True
        return {"edge": edge, "duplicate": duplicate}

    def delete_edge(self, edge_id: int) -> None:
        with self.db(write=True) as conn:
            row = conn.execute("SELECT source_node_id, target_node_id, edge_type, label FROM edges WHERE id=?",
                               (edge_id,)).fetchone()
            if not row:
                raise NotFound(f"edge {edge_id} not found")
            self.log_action(conn, "edge_delete", "edge", str(edge_id),
                            {"source": row[0], "target": row[1], "type": row[2], "label": row[3]}, None)
            conn.execute("DELETE FROM edge_confirmations WHERE edge_id=?", (edge_id,))
            conn.execute("DELETE FROM edges WHERE id=?", (edge_id,))

    def merge(self, source_id: str, target_id: str) -> dict:
        """Merge source_id INTO target_id: re-point edges, carry over the owner's state, delete source_id.
        The target wins conflicts; notes and details are appended."""
        if not target_id:
            raise BrainError("target_id required")
        if source_id == target_id:
            raise BrainError("can't merge a node into itself")
        with self.db(write=True) as conn:
            src = conn.execute("SELECT id, label, type, detail FROM nodes WHERE id=?", (source_id,)).fetchone()
            tgt = conn.execute("SELECT id, label, type, detail FROM nodes WHERE id=?", (target_id,)).fetchone()
            if not src or not tgt:
                raise BrainError("source or target node not found")
            moved = dropped = 0
            for eid, s, t, etype in conn.execute("SELECT id, source_node_id, target_node_id, edge_type FROM edges "
                                                 "WHERE source_node_id=? OR target_node_id=?",
                                                 (source_id, source_id)).fetchall():
                ns, nt = (target_id if s == source_id else s), (target_id if t == source_id else t)
                dup = conn.execute("SELECT id FROM edges WHERE source_node_id=? AND target_node_id=? AND edge_type=?",
                                   (ns, nt, etype)).fetchone()
                if ns == nt or (dup and dup[0] != eid):
                    conn.execute("DELETE FROM edge_confirmations WHERE edge_id=?", (eid,))
                    conn.execute("DELETE FROM edges WHERE id=?", (eid,))
                    dropped += 1
                else:
                    conn.execute("UPDATE edges SET source_node_id=?, target_node_id=? WHERE id=?", (ns, nt, eid))
                    moved += 1

            def one(sql: str, nid: str):
                r = conn.execute(sql, (nid,)).fetchone()
                return r[0] if r else None
            q_conf = "SELECT status FROM node_confirmations WHERE node_id=?"
            if one(q_conf, target_id) is None and (sc := one(q_conf, source_id)):
                conn.execute("INSERT INTO node_confirmations (node_id, status) VALUES (?, ?)", (target_id, sc))
            conn.execute("DELETE FROM node_confirmations WHERE node_id=?", (source_id,))
            q_note = "SELECT text FROM node_notes WHERE node_id=?"
            if sn := one(q_note, source_id):
                tn = one(q_note, target_id)
                text = f"{tn}\n\n--- merged from {src['label']} ---\n{sn}" if tn else sn
                conn.execute("INSERT INTO node_notes (node_id, text) VALUES (?, ?) ON CONFLICT(node_id) DO UPDATE "
                             "SET text=excluded.text, updated_at=CURRENT_TIMESTAMP", (target_id, text))
            conn.execute("DELETE FROM node_notes WHERE node_id=?", (source_id,))
            q_rn = "SELECT custom_label FROM node_renames WHERE node_id=?"
            if one(q_rn, target_id) is None and (sr := one(q_rn, source_id)):
                conn.execute("INSERT INTO node_renames (node_id, custom_label) VALUES (?, ?)", (target_id, sr))
            conn.execute("DELETE FROM node_renames WHERE node_id=?", (source_id,))
            if src["type"] == "question":
                q_ans = "SELECT text FROM answers WHERE question_id=?"
                if (sa := one(q_ans, source_id)) and one(q_ans, target_id) is None:
                    conn.execute("INSERT INTO answers (question_id, text) VALUES (?, ?)", (target_id, sa))
                conn.execute("DELETE FROM answers WHERE question_id=?", (source_id,))
            conn.execute("UPDATE agent_messages SET node_id=? WHERE node_id=?", (target_id, source_id))
            for (d,) in conn.execute("SELECT domain_id FROM node_domains WHERE node_id=?", (source_id,)).fetchall():
                conn.execute("INSERT OR IGNORE INTO node_domains (node_id, domain_id) VALUES (?, ?)", (target_id, d))
            conn.execute("DELETE FROM node_domains WHERE node_id=?", (source_id,))
            sd, td = src["detail"], tgt["detail"]
            if sd and sd.strip() and sd != td:
                conn.execute("UPDATE nodes SET detail=? WHERE id=?",
                             (sd if not td else f"{td}\n\n[merged from {src['label']}] {sd}", target_id))
            conn.execute("UPDATE highlights_full SET source_id=? WHERE source_id=?", (target_id, source_id))
            conn.execute("UPDATE nodes SET source_id=? WHERE source_id=?", (target_id, source_id))
            conn.execute("UPDATE zotero_items SET node_id=? WHERE node_id=?", (target_id, source_id))
            conn.execute("DELETE FROM nodes WHERE id=?", (source_id,))
            self.log_action(conn, "node_merge", "node", source_id,
                            {"source": src["label"], "edges_moved": moved, "edges_dropped": dropped},
                            {"merged_into": target_id, "target_label": tgt["label"]})
        return {"moved": moved, "dropped": dropped, "source_label": src["label"], "target_label": tgt["label"]}

    # ---- Gemini ------------------------------------------------------------------------------------------------
    @property
    def ai_ready(self) -> bool:
        return bool(self.gemini_key)

    def health(self) -> dict:
        return {"ok": self.ai_ready, "model": self.gemini_model if self.ai_ready else None,
                "error": None if self.ai_ready else "AI not configured (set GEMINI_API_KEY on the server)",
                "db": self.exists()}

    def _gemini(self, method: str, body: dict, stream: bool = False):
        if not self.gemini_key:
            raise AINotConfigured("AI not configured: set GEMINI_API_KEY in the server's environment")
        url = f"{GEMINI_API}/{self.gemini_model}:{method}" + ("?alt=sse" if stream else "")
        req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json", "x-goog-api-key": self.gemini_key})
        try:
            return self.opener(req, timeout=120)
        except urllib.error.HTTPError as e:
            msg = e.read()[:300].decode("utf-8", "replace")
            raise RuntimeError(f"Gemini HTTP {e.code}: {msg}")
        except (urllib.error.URLError, TimeoutError) as e:
            raise RuntimeError(f"Gemini unreachable: {e}")

    @staticmethod
    def _text_of(resp: dict) -> str:
        parts = ((resp.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
        return "".join(p.get("text", "") for p in parts if isinstance(p, dict))

    def extract(self, text: str, max_existing: int = 400) -> dict:
        """Pasted text -> {concepts, questions, comments} (nothing is saved; the UI lets the owner pick)."""
        text = (text or "").strip()
        if not text:
            raise BrainError("text required")
        if len(text) > 20000:
            raise BrainError("text too long (>20k chars)")
        if not self.ai_ready:
            raise AINotConfigured("AI not configured: set GEMINI_API_KEY in the server's environment")
        with self.db() as conn:
            existing = conn.execute("SELECT id, type, label FROM nodes WHERE type IN ('concept','project','source') "
                                    "ORDER BY type, label LIMIT ?", (max_existing,)).fetchall()
            domains = [r[0] for r in conn.execute("SELECT id FROM domains")]
        system = EXTRACT_PROMPT.format(domains=", ".join(domains) or "(none)", count=len(existing),
                                       existing="\n".join(f"  - {r[0]} ({r[1]}): {r[2]}" for r in existing))
        body = {"systemInstruction": {"parts": [{"text": system}]},
                "contents": [{"role": "user", "parts": [{"text": text}]}],
                "generationConfig": {"responseMimeType": "application/json", "responseSchema": EXTRACT_SCHEMA}}
        with self._gemini("generateContent", body) as r:
            out = json.loads(r.read())
        try:
            data = json.loads(self._text_of(out) or "{}")
        except ValueError:
            raise RuntimeError("Gemini returned something that is not JSON")
        ids = {r[0] for r in existing}
        return {"concepts": [c for c in data.get("concepts") or [] if isinstance(c, dict) and c.get("label")],
                "questions": [q for q in data.get("questions") or [] if isinstance(q, dict) and q.get("label")],
                "comments": [c for c in data.get("comments") or []
                             if isinstance(c, dict) and c.get("text") and c.get("attach_to") in ids]}

    def explain_prompt(self, node_id: str, question: str) -> tuple[str, str]:
        with self.db() as conn:
            n = self._need_node(conn, node_id)
            neigh = conn.execute("""
                SELECT e.edge_type, e.label, m.label FROM edges e JOIN nodes m
                  ON m.id = CASE WHEN e.source_node_id=? THEN e.target_node_id ELSE e.source_node_id END
                WHERE e.source_node_id=? OR e.target_node_id=? LIMIT 12""", (node_id, node_id, node_id)).fetchall()
            projects = conn.execute("SELECT label, detail FROM nodes WHERE type='project' ORDER BY label").fetchall()
            doms = [r[0] for r in conn.execute("SELECT domain_id FROM node_domains WHERE node_id=?", (node_id,))]
            sources: list[tuple[str, list]] = []
            if n["type"] == "source":
                sources = [(n["label"], conn.execute("SELECT page, text, yue_comment FROM highlights_full WHERE source_id=? "
                                                     "ORDER BY (yue_comment IS NULL), page LIMIT 10", (node_id,)).fetchall())]
            elif n["type"] == "concept":
                for sid, slabel in conn.execute("""SELECT s.id, s.label FROM edges e JOIN nodes s ON s.id = e.source_node_id
                        WHERE e.target_node_id=? AND e.edge_type='instantiates' AND s.type='source' LIMIT 3""",
                                                (node_id,)).fetchall():
                    sources.append((slabel, conn.execute("SELECT page, text, yue_comment FROM highlights_full "
                                                         "WHERE source_id=? ORDER BY (yue_comment IS NULL), page LIMIT 6",
                                                         (sid,)).fetchall()))
        parts = [f"- type: {n['type']}" + (f" / {n['subtype']}" if n["subtype"] else ""), f"- label: {n['label']}"]
        if n["detail"]:
            parts.append(f"- description: {n['detail']}")
        if n["yue_comment"]:
            parts.append(f"- the user's comment at the time: {n['yue_comment']}")
        if n["page"]:
            parts.append(f"- page: p.{n['page']}")
        if doms:
            parts.append(f"- domains: {', '.join(doms)}")
        blocks = []
        for label, hs in sources[:3]:
            b = [f"* {label}"]
            for h in hs:
                b.append(f"  - p.{h[0] if h[0] is not None else '?'}: \"{(h[1] or '')[:200]}\"")
                if h[2]:
                    b.append(f"    comment: {h[2]}")
            blocks.append("\n".join(b))
        system = EXPLAIN_PROMPT.format(
            projects="\n".join(f"- {p[0]}" + (f": {p[1]}" if p[1] else "") for p in projects) or "(none listed)",
            node_summary="\n".join(parts),
            neighbors_summary="\n".join(f"- ({r[0]}) {r[2]}" + (f" - {r[1]}" if r[1] else "") for r in neigh) or "(none)",
            highlights="\n\n".join(blocks) or "(no direct source highlights found)",
            language=ANSWER_LANGUAGE)
        return system, (question or "").strip() or DEFAULT_QUESTION

    def explain(self, node_id: str, question: str = "") -> Iterator[str]:
        """Start an "ask AI" turn: checks + saves the question now, returns a generator streaming the answer
        (saved to agent_messages when it ends)."""
        if not self.ai_ready:
            raise AINotConfigured("AI not configured: set GEMINI_API_KEY in the server's environment")
        system, q = self.explain_prompt(node_id, question)  # raises NotFound
        with self.db(write=True) as conn:
            history = conn.execute("SELECT role, content FROM agent_messages WHERE node_id=? ORDER BY id",
                                   (node_id,)).fetchall()
            conn.execute("INSERT INTO agent_messages (node_id, role, content) VALUES (?, 'user', ?)", (node_id, q))
        contents = [{"role": "user" if r[0] == "user" else "model", "parts": [{"text": r[1]}]} for r in history]
        contents.append({"role": "user", "parts": [{"text": q}]})
        body = {"systemInstruction": {"parts": [{"text": system}]}, "contents": contents}

        def gen() -> Iterator[str]:
            got: list[str] = []
            try:
                with self._gemini("streamGenerateContent", body, stream=True) as r:
                    for raw in r:
                        line = raw.decode("utf-8", "replace").strip()
                        if not line.startswith("data:"):
                            continue
                        try:
                            chunk = self._text_of(json.loads(line[5:]))
                        except ValueError:
                            continue
                        if chunk:
                            got.append(chunk)
                            yield chunk
            except Exception as exc:  # shown in the chat pane; the partial answer is still saved
                err = f"\n\n[ERROR] {exc}"
                got.append(err)
                yield err
            full = "".join(got).strip()
            if full:
                with self.db(write=True) as conn:
                    conn.execute("INSERT INTO agent_messages (node_id, role, content) VALUES (?, 'assistant', ?)",
                                 (node_id, full))
        return gen()
