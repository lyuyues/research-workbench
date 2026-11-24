"""Reading panel: a reading list with PDFs, highlights and notes, linked to Zotero.

Files under Research/ (each has exactly one writer, so Nextcloud never sees two-sided edits):
  reading/library.json            server   the reading list (papers + status + tags + 0-5 star rating + "add to Zotero")
  reading/pdfs/<id>.pdf           server (downloaded) or the Mac bridge (copied from Zotero storage)
  reading/annotations/<id>.json   server   highlights made in the panel (PDF points, Zotero-compatible)
  reading/zotero_server.json      server   Zotero web-API sync state (note keys, pulled Zotero highlights)
  reading/zotero_bridge.json      Mac      tools/zotero_bridge.py: Zotero item/attachment keys, PDF copy state
  reading/zotero_index.json       Mac      searchable export of the Zotero library
  literature-radar/reading-notes/<slug>.md   notes (markdown, shared with the deep-reading notes); the
                                  "## Highlights" block between the markers is regenerated from the highlights.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

LIB = "reading/library.json"
PDF_DIR = "reading/pdfs"
ANN_DIR = "reading/annotations"
SERVER = "reading/zotero_server.json"
BRIDGE = "reading/zotero_bridge.json"
INDEX = "reading/zotero_index.json"
NOTES_DIR = "literature-radar/reading-notes"
STATUSES = ("to-read", "reading", "done", "dropped")
COLORS = {"yellow": "#ffd400", "red": "#ff6666", "green": "#5fb236", "blue": "#2ea8e5", "purple": "#a28ae5"}
EMOJI = {"yellow": "🟨", "red": "🟥", "green": "🟩", "blue": "🟦", "purple": "🟪"}
HL_START = "<!-- highlights:start · generated from the Reading panel, edits inside this block are overwritten -->"
HL_END = "<!-- highlights:end -->"
PID = re.compile(r"^(arxiv|doi|zotero|t)-[A-Za-z0-9._-]{1,80}$")
ARXIV = re.compile(r"(?:arxiv\.org/(?:abs|pdf)/|arXiv[.:]\s?)(\d{4}\.\d{4,5})(?:v\d+)?", re.I)
ARXIV_ID = re.compile(r"^\d{4}\.\d{4,5}$")
DOI = re.compile(r"(10\.\d{4,9}/[^\s\"<>]+)")
MAX_PDF = 100 * 1024 * 1024
UA = "research-platform/1.0 (reading list; personal use)"


class NotesConflict(Exception):
    pass


def _json(p: Path, default):
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        return d if isinstance(d, type(default)) else default
    except (OSError, ValueError):
        return default


def _atomic(p: Path, data: str | bytes) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(f".{p.name}.tmp")
    tmp.write_bytes(data.encode("utf-8") if isinstance(data, str) else data)
    os.replace(tmp, p)


def _dump(p: Path, obj) -> None:
    _atomic(p, json.dumps(obj, ensure_ascii=False, indent=1) + "\n")


def norm_title(t: str) -> str:
    """Lower-case letters and digits of any script (Chinese titles used to normalise to "")."""
    return re.sub(r"[\W_]+", " ", (t or "").casefold()).strip()


def slug(title: str) -> str:
    words = re.sub(r"[^A-Za-z0-9]+", " ", title.split(":")[0] if len(title.split(":")[0]) > 12 else title).split()
    s = "-".join(words)[:60].strip("-")
    return s or "paper-" + hashlib.sha1(title.encode()).hexdigest()[:8]


def normalize(meta: dict) -> dict:
    """Clean user/feed metadata; detects arXiv ids and DOIs in URLs."""
    s = lambda k, n=500: str(meta.get(k) or "").strip()[:n]  # noqa: E731
    title = " ".join(s("title", 400).split())
    url, pdf_url, doi, arxiv = s("url", 1000), s("pdf_url", 1000), s("doi", 200), s("arxiv", 40)
    for u in (url, pdf_url, doi):
        if not arxiv and (m := ARXIV.search(u)):
            arxiv = m.group(1)
    arxiv = re.sub(r"v\d+$", "", arxiv)
    if arxiv and not ARXIV_ID.match(arxiv):
        raise ValueError("bad arXiv id")
    if not doi and (m := DOI.search(url)):
        doi = m.group(1)
    doi = re.sub(r"^https?://(dx\.)?doi\.org/", "", doi).rstrip(".")
    if doi and not DOI.fullmatch(doi):
        raise ValueError("bad DOI")
    for u in (url, pdf_url):
        if u and not re.match(r"^https?://\S+$", u):
            raise ValueError("links must be http(s) URLs")
    zkey = s("zotero_key", 20)
    if zkey and not re.fullmatch(r"[A-Z0-9]{8}", zkey):
        raise ValueError("bad Zotero key")
    if not title:
        raise ValueError("a paper needs a title")
    authors = meta.get("authors") or []
    if isinstance(authors, str):
        authors = [a.strip() for a in re.split(r",|;| and ", authors) if a.strip()]
    return {"title": title, "authors": [str(a)[:120] for a in authors][:30], "year": s("year", 10),
            "venue": s("venue", 200), "doi": doi, "arxiv": arxiv, "url": url or (f"https://arxiv.org/abs/{arxiv}" if arxiv else
            f"https://doi.org/{doi}" if doi else ""), "pdf_url": pdf_url, "zotero_key": zkey,
            "source": s("source", 20) or "manual"}


def clean_tags(tags) -> list[str]:
    """Trim, collapse spaces, drop empties and case-insensitive duplicates (first spelling wins), keep order."""
    out, seen = [], set()
    for t in tags or []:
        t = re.sub(r"\s+", " ", str(t)).strip().lstrip("#")[:40]
        if t and t.lower() not in seen:
            seen.add(t.lower())
            out.append(t)
    if len(out) > 30:
        raise ValueError("at most 30 tags")
    return out


def paper_id(m: dict) -> str:
    if m["arxiv"]:
        return f"arxiv-{m['arxiv']}"
    if m["zotero_key"]:
        return f"zotero-{m['zotero_key']}"
    if m["doi"]:
        return "doi-" + hashlib.sha1(m["doi"].lower().encode()).hexdigest()[:12]
    return "t-" + hashlib.sha1(norm_title(m["title"]).encode()).hexdigest()[:12]


def fetch(url: str, *, limit: int = MAX_PDF, timeout: int = 60, opener=None) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/pdf,*/*"})
    with (opener or urllib.request.urlopen)(req, timeout=timeout) as r:
        data = r.read(limit + 1)
    if len(data) > limit:
        raise ValueError("file too large")
    return data


ZNOTES_MARK = "<!-- zotero-notes · notes written in Zotero (read-only here; edit them in Zotero) -->"


def md_block(highlights: list[dict], zotero: list[dict], znotes: list[dict] | None = None) -> str:
    rows = sorted([(h["page"], h.get("top", 0), h, "") for h in highlights] +
                  [(z["page"], z.get("top", 0), z, " · _Zotero_") for z in zotero], key=lambda r: (r[0], r[1]))
    lines = [HL_START, "## Highlights", ""]
    if not rows:
        lines.append("_No highlights yet._")
    for page, _, h, src in rows:
        text = " ".join((h.get("text") or "").split())
        quote = f"“{text}”" if text else "_(note)_"
        line = f"- {EMOJI.get(h.get('color'), '🟨')} **p.{page + 1}**{src} {quote}"
        if c := " ".join((h.get("comment") or "").split()):
            line += f" — {c}"
        lines.append(line)
    if znotes:
        lines += ["", ZNOTES_MARK, "## From Zotero", ""]
        for n in znotes:
            lines += [n["md"].strip(), ""]
        lines.pop()
    lines += ["", HL_END]
    return "\n".join(lines)


def without_znotes(text: str) -> str:
    """The notes text minus the pulled Zotero notes (so they are not pushed back into Zotero)."""
    a, b = text.find(ZNOTES_MARK), text.find(HL_END)
    return text[:a].rstrip() + "\n\n" + text[b:] if a != -1 and b > a else text


def strip_block(text: str) -> str:
    a, b = text.find(HL_START), text.find(HL_END)
    return text[:a] + text[b + len(HL_END):] if a != -1 and b > a else text


def put_block(text: str, block: str) -> str:
    a, b = text.find(HL_START), text.find(HL_END)
    if a != -1 and b > a:
        return text[:a] + block + text[b + len(HL_END):]
    return text.rstrip() + "\n\n" + block + "\n"


class Reading:
    def __init__(self, research_root: Path, opener=None):
        self.root = Path(research_root)
        self.lock = threading.RLock()
        self.opener = opener  # tests inject a fake urlopen

    def p(self, rel: str) -> Path:
        return self.root / rel

    # ---------------------------------------------------------------- library
    def _lib(self) -> list[dict]:
        return _json(self.p(LIB), {}).get("papers") or []

    def _save_lib(self, papers: list[dict]) -> None:
        _dump(self.p(LIB), {"papers": papers})

    def paper(self, pid: str) -> dict:
        if not PID.match(pid or ""):
            raise ValueError("bad paper id")
        for x in self._lib():
            if x["id"] == pid:
                return x
        raise KeyError(pid)

    def bridge(self) -> dict:
        return _json(self.p(BRIDGE), {})

    def server_state(self) -> dict:
        return _json(self.p(SERVER), {})

    def save_server_state(self, st: dict) -> None:
        with self.lock:
            _dump(self.p(SERVER), st)

    def zotero_keys(self, x: dict, bridge: dict | None = None) -> tuple[str | None, str | None]:
        """(item key, PDF attachment key) for a paper, from the paper itself or the Mac bridge."""
        b = ((bridge if bridge is not None else self.bridge()).get("papers") or {}).get(x["id"]) or {}
        return x.get("zotero_key") or b.get("key"), b.get("attachment_key") or x.get("zotero_attachment")

    def _decorate(self, x: dict, bridge: dict, server: dict) -> dict:
        pdf = self.p(x["pdf"])
        key, att = self.zotero_keys(x, bridge)
        b = (bridge.get("papers") or {}).get(x["id"]) or {}
        s = (server.get("papers") or {}).get(x["id"]) or {}
        if pdf.is_file():
            pdf_state = "ok"
        elif x.get("pdf_error"):
            pdf_state = "failed"
        elif x.get("zotero_attachment") or (x.get("zotero_key") and not x.get("pdf_url")):
            pdf_state = "failed" if b.get("pdf_error") else "waiting-mac"
        else:
            pdf_state = "downloading"
        if not key:
            z = "queued" if x.get("zotero_want") else "off"
        elif s.get("error"):
            z = "error"
        elif s.get("synced_at"):
            z = "synced"
        else:
            z = "pending"
        hl = _json(self.p(f"{ANN_DIR}/{x['id']}.json"), {}).get("highlights") or []
        return {**x, "pdf_state": pdf_state, "pdf_error": x.get("pdf_error") or b.get("pdf_error"),
                "highlights": len(hl), "notes_exists": self.p(x["notes"]).is_file(),
                "zotero": {"state": z, "key": key, "attachment_key": att, "synced_at": s.get("synced_at"),
                           "error": s.get("error") or b.get("error"), "bridge_state": b.get("state")}}

    def view(self) -> dict:
        bridge, server = self.bridge(), self.server_state()
        papers = [self._decorate(x, bridge, server) for x in self._lib()]
        papers.sort(key=lambda x: (STATUSES.index(x.get("status", "to-read")) if x.get("status") in STATUSES else 9,
                                   -(x.get("opened") or x.get("added") or 0)))
        idx = self.p(INDEX)
        return {"papers": papers, "bridge_updated": bridge.get("updated"),
                "index_updated": int(idx.stat().st_mtime * 1000) if idx.is_file() else None,
                "collection": server.get("collection_name")}

    def add(self, meta: dict, *, zotero: bool = False) -> tuple[dict, bool]:
        m = normalize(meta)
        with self.lock:
            papers = self._lib()
            nt = norm_title(m["title"])
            for x in papers:
                other_item = bool(m["zotero_key"] and x.get("zotero_key") and x["zotero_key"] != m["zotero_key"])
                if ((m["arxiv"] and x.get("arxiv") == m["arxiv"]) or (m["doi"] and x.get("doi", "").lower() == m["doi"].lower())
                        or (m["zotero_key"] and x.get("zotero_key") == m["zotero_key"])
                        or (nt and not other_item and norm_title(x["title"]) == nt)):
                    changed = False
                    for k in ("zotero_key", "doi", "arxiv", "pdf_url"):
                        if m[k] and not x.get(k):
                            x[k], changed = m[k], True
                    if zotero and not x.get("zotero_want"):
                        x["zotero_want"], changed = True, True
                    if changed:
                        self._save_lib(papers)
                    return x, False
            pid = paper_id(m)
            notes = f"{NOTES_DIR}/{slug(m['title'])}.md"
            x = {"id": pid, **m, "added": int(time.time() * 1000), "status": "to-read",
                 "zotero_want": bool(zotero or m["zotero_key"]), "pdf": f"{PDF_DIR}/{pid}.pdf", "notes": notes}
            if meta.get("zotero_attachment") and re.fullmatch(r"[A-Z0-9]{8}", str(meta["zotero_attachment"])):
                x["zotero_attachment"] = meta["zotero_attachment"]
            papers.append(x)
            self._save_lib(papers)
            return x, True

    def update(self, pid: str, **fields) -> dict:
        with self.lock:
            papers = self._lib()
            for x in papers:
                if x["id"] == pid:
                    if "status" in fields and fields["status"] not in STATUSES:
                        raise ValueError("bad status")
                    if "tags" in fields:
                        fields["tags"] = clean_tags(fields["tags"])
                    if "rating" in fields and fields["rating"] not in range(6):
                        raise ValueError("rating must be 0-5")
                    x.update({k: v for k, v in fields.items()})
                    self._save_lib(papers)
                    return x
        raise KeyError(pid)

    # ---------------------------------------------------------------- PDFs
    def resolve_pdf_url(self, x: dict) -> str | None:
        if x.get("pdf_url"):
            return x["pdf_url"]
        if x.get("arxiv"):
            return f"https://arxiv.org/pdf/{x['arxiv']}"
        if x.get("doi"):
            if x["doi"].lower().startswith("10.48550/arxiv."):
                return f"https://arxiv.org/pdf/{x['doi'][15:]}"
            try:
                q = urllib.parse.quote(f"DOI:{x['doi']}", safe=":/")
                d = json.loads(fetch(f"https://api.semanticscholar.org/graph/v1/paper/{q}?fields=openAccessPdf,externalIds",
                                     limit=1_000_000, timeout=20, opener=self.opener))
            except Exception:
                return None
            if ax := (d.get("externalIds") or {}).get("ArXiv"):
                return f"https://arxiv.org/pdf/{ax}"
            return ((d.get("openAccessPdf") or {}).get("url")) or None
        return None

    def download_pdf(self, pid: str) -> str:
        """Fetch the PDF for a paper (no-op if present). Returns the resulting pdf_state."""
        x = self.paper(pid)
        dest = self.p(x["pdf"])
        if dest.is_file():
            return "ok"
        if x.get("zotero_attachment"):
            return "waiting-mac"  # use Zotero's own file, so highlights line up in both places
        url = self.resolve_pdf_url(x)
        if not url:
            if x.get("zotero_key"):
                return "waiting-mac"  # the Mac bridge copies it from Zotero storage
            self.update(pid, pdf_error="no open-access PDF found — add one by URL, or add the paper to Zotero")
            return "failed"
        try:
            data = fetch(url, opener=self.opener)
            if not data.startswith(b"%PDF"):
                raise ValueError("the link did not return a PDF")
        except Exception as exc:
            self.update(pid, pdf_error=f"download failed: {str(exc)[:200]}", pdf_url=x.get("pdf_url") or "")
            return "failed"
        _atomic(dest, data)
        self.update(pid, pdf_error=None, pdf_url=x.get("pdf_url") or url)
        return "ok"

    # ---------------------------------------------------------------- highlights
    def _ann_path(self, pid: str) -> Path:
        return self.p(f"{ANN_DIR}/{pid}.json")

    def annotations(self, pid: str) -> dict:
        d = _json(self._ann_path(pid), {})
        return {"highlights": d.get("highlights") or [], "deleted": d.get("deleted") or []}

    def save_annotations(self, pid: str, ann: dict) -> None:
        with self.lock:
            _dump(self._ann_path(pid), ann)

    @staticmethod
    def clean_highlight(h: dict) -> dict:
        try:
            page = int(h["page"])
            rects = [[round(float(v), 2) for v in r] for r in h.get("rects") or []]
        except (KeyError, TypeError, ValueError):
            raise ValueError("bad highlight")
        if page < 0 or page > 5000 or not 1 <= len(rects) <= 300 or any(len(r) != 4 for r in rects):
            raise ValueError("bad highlight position")
        color = h.get("color") or "yellow"
        if color not in COLORS:
            raise ValueError("bad colour")
        top = float(h.get("top") or max(r[3] for r in rects))
        return {"page": page, "rects": rects, "top": round(top, 1), "page_height": float(h.get("page_height") or 792),
                "text": str(h.get("text") or "")[:5000], "comment": str(h.get("comment") or "")[:5000], "color": color}

    def add_highlight(self, pid: str, h: dict) -> dict:
        self.paper(pid)
        with self.lock:
            ann = self.annotations(pid)
            new = {"id": secrets.token_hex(4), **self.clean_highlight(h), "created": int(time.time() * 1000)}
            ann["highlights"].append(new)
            self.save_annotations(pid, ann)
        self.refresh_notes(pid)
        return new

    def edit_highlight(self, pid: str, hid: str, *, comment: str | None = None, color: str | None = None,
                       delete: bool = False) -> None:
        with self.lock:
            ann = self.annotations(pid)
            h = next((h for h in ann["highlights"] if h["id"] == hid), None)
            if h is None:
                raise KeyError(hid)
            if delete:
                ann["highlights"].remove(h)
                if h.get("zotero_key"):
                    ann["deleted"].append({"key": h["zotero_key"], "version": h.get("zotero_version")})
            else:
                if color is not None:
                    if color not in COLORS:
                        raise ValueError("bad colour")
                    h["color"] = color
                if comment is not None:
                    h["comment"] = comment[:5000]
            self.save_annotations(pid, ann)
        self.refresh_notes(pid)

    # ---------------------------------------------------------------- notes
    def notes_template(self, x: dict) -> str:
        link = f"[DOI](https://doi.org/{x['doi']})" if x.get("doi") else x.get("url") or ""
        return (f"# {x['title']}\n\n**Authors**: {', '.join(x.get('authors') or [])}\n"
                f"**Venue/Year**: {' '.join(v for v in (x.get('venue'), x.get('year')) if v)}\n"
                f"**Link/DOI**: {link}\n\n## My notes\n\n\n")

    def notes(self, pid: str) -> dict:
        x = self.paper(pid)
        p = self.p(x["notes"])
        if p.is_file():
            return {"path": x["notes"], "text": p.read_text(encoding="utf-8"), "exists": True,
                    "mtime": int(p.stat().st_mtime * 1000)}
        return {"path": x["notes"], "text": self.notes_template(x), "exists": False, "mtime": None}

    def _block(self, pid: str) -> str:
        ps = (self.server_state().get("papers") or {}).get(pid) or {}
        return md_block(self.annotations(pid)["highlights"], ps.get("annotations") or [], ps.get("zotero_notes") or [])

    def refresh_notes(self, pid: str) -> None:
        """Regenerate the highlights block (creates the notes file on the first highlight)."""
        with self.lock:
            cur = self.notes(pid)
            hl = self.annotations(pid)["highlights"]
            if not cur["exists"] and not hl and not ((self.server_state().get("papers") or {}).get(pid) or {}).get("zotero_notes"):
                return
            new = put_block(cur["text"], self._block(pid))
            if new != cur["text"]:
                _atomic(self.p(cur["path"]), new)

    def save_notes(self, pid: str, text: str, expect: str) -> str:
        """The highlights block is regenerated, so it is ignored by the conflict check."""
        with self.lock:
            cur = self.notes(pid)
            if strip_block(cur["text"]).strip() != strip_block(expect).strip():
                raise NotesConflict("the notes changed since you opened them (the agent or another device?) — reload")
            if not text.strip():
                raise ValueError("notes are empty")
            _atomic(self.p(cur["path"]), put_block(text, self._block(pid)).rstrip() + "\n")
            return cur["path"]

    # ---------------------------------------------------------------- Zotero library (exported by the Mac)
    def zotero_search(self, q: str, limit: int = 30) -> list[dict]:
        words = norm_title(q).split()
        if not words:
            return []
        items = _json(self.p(INDEX), {}).get("items") or []
        mine = {x.get("zotero_key") for x in self._lib()}
        out = []
        for it in items:
            hay = norm_title(" ".join([it.get("title", ""), " ".join(it.get("creators") or []), str(it.get("year", "")),
                                       it.get("doi", ""), it.get("venue", ""), " ".join(it.get("collections") or [])]))
            if all(w in hay for w in words):
                out.append({**it, "in_list": it.get("key") in mine})
                if len(out) >= limit:
                    break
        return out

    def zotero_item(self, key: str) -> dict | None:
        return next((it for it in _json(self.p(INDEX), {}).get("items") or [] if it.get("key") == key), None)
