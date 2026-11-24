"""Zotero web API sync for the Reading panel (server side).

Key + user id live in ~/.config/research-platform/zotero.json ({"user_id": "...", "api_key": "..."}, 0600).
Items and PDFs enter Zotero through the Mac bridge (tools/zotero_bridge.py, local connector), because
PDF attachments live on the user's WebDAV storage. Once an item exists, the server keeps, per paper:
  * one child note "Reading notes (research platform)" = the notes file + highlights, updated in place;
  * every panel highlight as a real Zotero highlight annotation on the PDF (same coordinates, so it
    shows up in the Zotero reader on the Mac and iPad);
and pulls highlights made in Zotero back into the panel (read-only there).
"""
from __future__ import annotations

import hashlib
import html
import json
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

from .reading import COLORS, Reading, without_znotes

API = "https://api.zotero.org"
COLLECTION = "Reading (platform)"
NOTE_TAG = "research-platform"
HEX2NAME = {v: k for k, v in COLORS.items()}


class ZoteroError(Exception):
    pass


def load_config(path: Path | None) -> dict | None:
    try:
        d = json.loads(Path(path).read_text()) if path else None
    except (OSError, ValueError):
        return None
    if not isinstance(d, dict) or not re.fullmatch(r"\d{1,12}", str(d.get("user_id", ""))) \
            or not re.fullmatch(r"[A-Za-z0-9]{20,40}", str(d.get("api_key", ""))):
        return None
    return {"user_id": str(d["user_id"]), "api_key": d["api_key"]}


class ZoteroAPI:
    def __init__(self, user_id: str, api_key: str, opener=None):
        self.prefix = f"/users/{user_id}"
        self.key = api_key
        self.opener = opener or urllib.request.urlopen

    def call(self, method: str, path: str, body=None, version: int | None = None) -> tuple[int, dict, object]:
        headers = {"Zotero-API-Key": self.key, "Zotero-API-Version": "3", "User-Agent": "research-platform/1.0"}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        if version is not None:
            headers["If-Unmodified-Since-Version"] = str(version)
        req = urllib.request.Request(API + self.prefix + path, data=data, method=method, headers=headers)
        try:
            with self.opener(req, timeout=30) as r:
                raw = r.read()
                return r.status, dict(r.headers), (json.loads(raw) if raw.strip() else None)
        except urllib.error.HTTPError as e:
            msg = e.read()[:300].decode("utf-8", "replace")
            if e.code in (404, 412):
                return e.code, dict(e.headers or {}), None
            if e.code == 403:
                raise ZoteroError("Zotero refused the API key (403) — does it have library, notes and write access?")
            raise ZoteroError(f"Zotero API {method} {path.split('?')[0]}: HTTP {e.code} {msg}")
        except (urllib.error.URLError, TimeoutError) as e:
            raise ZoteroError(f"Zotero API unreachable: {e}")

    def create(self, items: list[dict]) -> list[tuple[str | None, int | None, str | None]]:
        """POST up to 50 items → [(key, version, error)] in order."""
        _, _, res = self.call("POST", "/items", items)
        res = res or {}
        out = []
        for i in range(len(items)):
            ok = (res.get("successful") or {}).get(str(i))
            if ok:
                out.append((ok["key"], ok.get("version"), None))
            else:
                fail = (res.get("failed") or {}).get(str(i)) or {}
                out.append((None, None, str(fail.get("message") or "not saved")[:200]))
        return out


def md_to_html(md: str) -> str:
    """Small markdown → Zotero note HTML (headings, lists, quotes, bold/italic, links)."""
    def inline(t: str) -> str:
        t = html.escape(t, quote=False)
        t = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", t)
        t = re.sub(r"(?<![\w*])_(.+?)_(?!\w)", r"<em>\1</em>", t)
        t = re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", r'<a href="\2">\1</a>', t)
        return t
    out, para, in_list = [], [], False

    def flush():
        nonlocal para
        if para:
            out.append("<p>" + "<br/>".join(inline(x) for x in para) + "</p>")
            para = []
    for ln in md.split("\n"):
        s = ln.rstrip()
        if s.startswith("<!--"):
            continue
        m = re.match(r"^(#{1,4})\s+(.*)$", s)
        li = re.match(r"^\s*[-*]\s+(.*)$", s)
        if not li and in_list:
            out.append("</ul>")
            in_list = False
        if m:
            flush()
            n = min(len(m.group(1)) + 1, 4)
            out.append(f"<h{n}>{inline(m.group(2))}</h{n}>")
        elif li:
            flush()
            if not in_list:
                out.append("<ul>")
                in_list = True
            out.append(f"<li>{inline(li.group(1))}</li>")
        elif s.startswith(">"):
            flush()
            out.append(f"<blockquote><p>{inline(s.lstrip('> '))}</p></blockquote>")
        elif not s.strip():
            flush()
        else:
            para.append(s)
    flush()
    if in_list:
        out.append("</ul>")
    return "\n".join(out)


def annotation_json(h: dict, attachment: str) -> dict:
    top_from_top = max(0, int(h.get("page_height", 792) - h.get("top", 0)))
    return {"itemType": "annotation", "parentItem": attachment, "annotationType": "highlight",
            "annotationText": h.get("text", ""), "annotationComment": h.get("comment", ""),
            "annotationColor": COLORS.get(h.get("color"), COLORS["yellow"]),
            "annotationPageLabel": str(h["page"] + 1),
            "annotationSortIndex": f"{h['page']:05d}|{0:06d}|{min(top_from_top, 99999):05d}",
            "annotationPosition": json.dumps({"pageIndex": h["page"], "rects": h["rects"]}),
            "tags": [{"tag": NOTE_TAG}]}


def sig(h: dict) -> str:
    return f"{h.get('color')}|{h.get('comment', '')}"


class ZoteroSync:
    def __init__(self, reading: Reading, api: ZoteroAPI):
        self.r = reading
        self.api = api

    def ensure_collection(self) -> str:
        st = self.r.server_state()
        if st.get("collection_key"):
            return st["collection_key"]
        start = 0
        while True:
            _, _, cols = self.api.call("GET", f"/collections?limit=100&start={start}")
            cols = cols or []
            for c in cols:
                if (c.get("data") or {}).get("name") == COLLECTION and not (c.get("data") or {}).get("parentCollection"):
                    key = c["key"]
                    break
            else:
                if len(cols) == 100:
                    start += 100
                    continue
                _, _, res = self.api.call("POST", "/collections", [{"name": COLLECTION}])
                ok = ((res or {}).get("successful") or {}).get("0")
                if not ok:
                    raise ZoteroError(f"could not create the {COLLECTION!r} collection")
                key = ok["key"]
            break
        st = self.r.server_state()
        st.update(collection_key=key, collection_name=COLLECTION)
        self.r.save_server_state(st)
        return key

    # Reading position = Zotero's synced "lastPageIndex_u_<attachment>" setting (0-based page index for PDFs);
    # Zotero desktop/iPad open the PDF there and update it as you read, so both sides share one position.
    @staticmethod
    def _page_setting(att: str) -> str:
        if not re.fullmatch(r"[A-Z0-9]{8}", att or ""):
            raise ZoteroError("bad attachment key")
        return f"/settings/lastPageIndex_u_{att}"

    def get_page(self, att: str) -> int | None:
        code, _, body = self.api.call("GET", self._page_setting(att))
        v = (body or {}).get("value") if code == 200 else None
        return int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0 else None

    def set_page(self, att: str, index: int) -> None:
        path = self._page_setting(att)
        for _ in range(2):
            code, _, body = self.api.call("GET", path)
            ver = (body or {}).get("version", 0) if code == 200 else 0
            if code == 200 and body.get("value") == index:
                return
            code, _, _ = self.api.call("PUT", path, {"value": int(index)}, version=ver)
            if code != 412:
                return
        raise ZoteroError("could not save the reading position to Zotero (version conflict)")

    def sync_paper(self, pid: str) -> dict:
        """Push notes + highlights, pull Zotero highlights. Returns a summary; records errors in state."""
        x = self.r.paper(pid)
        key, att = self.r.zotero_keys(x)
        summary = {"note": None, "pushed": 0, "updated": 0, "deleted": 0, "pulled": 0, "waiting": None}
        st = self.r.server_state()
        ps = (st.setdefault("papers", {})).setdefault(pid, {})
        try:
            if not key:
                summary["waiting"] = "the Mac bridge has not added it to Zotero yet"
                return summary
            code, _, item = self.api.call("GET", f"/items/{key}")
            if code == 404:
                summary["waiting"] = "the item is not on zotero.org yet (Zotero desktop sync pending)"
                ps["error"] = None
                return summary
            if att:
                code, _, _ = self.api.call("GET", f"/items/{att}")
                if code == 404:
                    summary["waiting"] = "the PDF attachment is not on zotero.org yet"
                else:
                    summary.update(self._annotations(pid, att, ps))
                    if summary["pulled"] or summary["deleted"]:
                        self._save_ps(pid, ps)  # the notes block reads pulled highlights from the state file
                        self.r.refresh_notes(pid)
            if self._pull_notes(key, ps):
                summary["pulled_notes"] = len(ps["zotero_notes"])
                self._save_ps(pid, ps)
                self.r.refresh_notes(pid)
            summary["note"] = self._note(x, key, ps)
            ps.update(synced_at=int(time.time() * 1000), error=None)
            return summary
        except ZoteroError as exc:
            ps["error"] = str(exc)[:300]
            raise
        finally:
            self._save_ps(pid, ps)

    def _save_ps(self, pid: str, ps: dict) -> None:
        with self.r.lock:
            fresh = self.r.server_state()
            fresh.setdefault("papers", {})[pid] = ps
            self.r.save_server_state(fresh)

    def _pull_notes(self, key: str, ps: dict) -> bool:
        """Child notes the user wrote in Zotero (not the platform's own synced note) → ps["zotero_notes"]. True if changed."""
        code, _, kids = self.api.call("GET", f"/items/{key}/children?itemType=note&limit=100")
        if code != 200 and kids is None:
            return False
        out = []
        for k in sorted(kids or [], key=lambda k: (k.get("data") or {}).get("dateAdded", "")):
            d = k.get("data") or {}
            body = d.get("note") or ""
            if k.get("key") == ps.get("note_key") or "Synced from the Reading panel on research.example.com" in body:
                continue
            md = html_to_md(body)
            if md:
                out.append({"key": k["key"], "md": md, "modified": d.get("dateModified", "")})
        if out == (ps.get("zotero_notes") or []):
            return False
        ps["zotero_notes"] = out
        return True

    def _note(self, x: dict, key: str, ps: dict) -> str | None:
        notes = self.r.notes(x["id"])
        if not notes["exists"]:
            return None
        body = ("<p><em>Synced from the Reading panel on research.example.com — edit the notes there; "
                "changes made to this note in Zotero are overwritten.</em></p>\n" + md_to_html(without_znotes(notes["text"])))
        h = re.sub(r"<[^>]+>", "", body)
        if ps.get("note_hash") == hash_text(h) and ps.get("note_key"):
            return "unchanged"
        if ps.get("note_key"):
            code, _, _ = self.api.call("PATCH", f"/items/{ps['note_key']}", {"note": body}, version=ps.get("note_version"))
            if code == 412:
                _, hdr, cur = self.api.call("GET", f"/items/{ps['note_key']}")
                code, _, _ = self.api.call("PATCH", f"/items/{ps['note_key']}", {"note": body},
                                           version=(cur or {}).get("version"))
            if code in (200, 204):
                ps["note_version"] = self._version(ps["note_key"])
                ps["note_hash"] = hash_text(h)
                return "updated"
            if code != 404:
                raise ZoteroError(f"could not update the Zotero note (HTTP {code})")
        [(nkey, ver, err)] = self.api.create([{"itemType": "note", "parentItem": key, "note": body,
                                               "tags": [{"tag": NOTE_TAG}]}])
        if err:
            raise ZoteroError(f"could not create the Zotero note: {err}")
        ps.update(note_key=nkey, note_version=ver, note_hash=hash_text(h))
        return "created"

    def _version(self, key: str) -> int | None:
        _, _, cur = self.api.call("GET", f"/items/{key}")
        return (cur or {}).get("version")

    def _annotations(self, pid: str, att: str, ps: dict) -> dict:
        out = {"pushed": 0, "updated": 0, "deleted": 0, "pulled": 0}
        with self.r.lock:
            ann = self.r.annotations(pid)
        # deletions
        done: set[str] = set()
        for d in list(ann["deleted"]):
            code, _, _ = self.api.call("DELETE", f"/items/{d['key']}", version=d.get("version") or self._version(d["key"]))
            if code == 412:
                code, _, _ = self.api.call("DELETE", f"/items/{d['key']}", version=self._version(d["key"]))
            if code in (204, 404):
                out["deleted"] += 1
                done.add(d["key"])
        # new
        new = [h for h in ann["highlights"] if not h.get("zotero_key")]
        for i in range(0, len(new), 50):
            chunk = new[i:i + 50]
            for h, (k, v, err) in zip(chunk, self.api.create([annotation_json(h, att) for h in chunk])):
                if k:
                    h.update(zotero_key=k, zotero_version=v, zotero_sig=sig(h))
                    out["pushed"] += 1
                else:
                    h["zotero_error"] = err
        # changed colour / comment
        for h in ann["highlights"]:
            if h.get("zotero_key") and h.get("zotero_sig") != sig(h):
                body = {"annotationComment": h.get("comment", ""), "annotationColor": COLORS.get(h["color"], COLORS["yellow"])}
                code, _, _ = self.api.call("PATCH", f"/items/{h['zotero_key']}", body, version=h.get("zotero_version"))
                if code == 412:
                    code, _, _ = self.api.call("PATCH", f"/items/{h['zotero_key']}", body, version=self._version(h["zotero_key"]))
                if code in (200, 204):
                    h.update(zotero_sig=sig(h), zotero_version=self._version(h["zotero_key"]))
                    out["updated"] += 1
        # merge back (highlights may have been added/edited meanwhile)
        with self.r.lock:
            cur = self.r.annotations(pid)
            by_id = {h["id"]: h for h in ann["highlights"]}
            for h in cur["highlights"]:
                if (src := by_id.get(h["id"])) and src.get("zotero_key"):
                    for k in ("zotero_key", "zotero_version"):
                        h[k] = src[k]
                    if sig(h) == src.get("zotero_sig"):
                        h["zotero_sig"] = src["zotero_sig"]
                    h.pop("zotero_error", None)
                elif src and src.get("zotero_error"):
                    h["zotero_error"] = src["zotero_error"]
            cur["deleted"] = [d for d in cur["deleted"] if d["key"] not in done]
            self.r.save_annotations(pid, cur)
            mine = {h.get("zotero_key") for h in cur["highlights"]} | {d["key"] for d in cur["deleted"]}
        # pull Zotero highlights (made in Zotero on the Mac / iPad)
        pulled, start = [], 0
        while True:
            _, _, kids = self.api.call("GET", f"/items/{att}/children?itemType=annotation&limit=100&start={start}")
            kids = kids or []
            for k in kids:
                d = k.get("data") or {}
                if k.get("key") in mine or d.get("annotationType") not in ("highlight", "underline", "note"):
                    continue
                try:
                    pos = json.loads(d.get("annotationPosition") or "{}")
                    page = int(pos.get("pageIndex", 0))
                except (ValueError, TypeError):
                    continue
                rects = [[float(v) for v in r] for r in pos.get("rects") or [] if len(r) == 4]
                pulled.append({"key": k["key"], "type": d["annotationType"], "page": page, "rects": rects,
                               "top": max((r[3] for r in rects), default=0), "text": d.get("annotationText") or "",
                               "comment": d.get("annotationComment") or "",
                               "color": HEX2NAME.get((d.get("annotationColor") or "").lower(), "yellow")})
            if len(kids) < 100:
                break
            start += 100
        if pulled != (ps.get("annotations") or []):
            out["pulled"] = max(len(pulled), 1)
        ps["annotations"] = pulled
        return out


def html_to_md(h: str) -> str:
    """Zotero note HTML → markdown (headings, lists, paragraphs, bold/italic, links); other tags dropped."""
    h = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", "", h)
    h = re.sub(r"(?is)<h([1-6])[^>]*>(.*?)</h\1>", lambda m: "\n\n" + "#" * min(6, int(m.group(1)) + 2) + " " + m.group(2) + "\n\n", h)
    h = re.sub(r"(?is)<li[^>]*>(.*?)</li>", r"\n- \1", h)
    h = re.sub(r"(?is)<blockquote[^>]*>(.*?)</blockquote>", lambda m: "\n> " + m.group(1).strip() + "\n", h)
    h = re.sub(r"(?is)<(strong|b)>(.*?)</\1>", r"**\2**", h)
    h = re.sub(r"(?is)<(em|i)>(.*?)</\1>", r"_\2_", h)
    h = re.sub(r'(?is)<a [^>]*href="(https?://[^"]+)"[^>]*>(.*?)</a>', r"[\2](\1)", h)
    h = re.sub(r"(?i)<br\s*/?>", "\n", h)
    h = re.sub(r"(?i)</(p|div|ul|ol|h\d|pre|table|tr)>", "\n\n", h)
    h = html.unescape(re.sub(r"<[^>]+>", "", h))
    lines = [ln.rstrip() for ln in h.splitlines()]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def hash_text(t: str) -> str:
    return hashlib.sha1(t.encode()).hexdigest()
