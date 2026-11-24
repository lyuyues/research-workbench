"""Story panel: one canvas per project that turns study data into the paper's story.

File: Research/<project dir>/story/canvas.json (projects come from projects.yaml) (the source of truth; the user drags things on the
panel, the agent edits the same file when asked to review the canvas). Shape:
  {"version": int, "title": str, "items": [item, ...]}
item kinds:
  section  a titled frame (paper flow band, D1–D4 columns, evidence pool)
  card     an evidence card; color = support | counter | caveat | gap | reviewer | flow | plain
  note     free text with no box
  arrow    joins two items: {"from": id, "to": id}
  image    a picture dropped/pasted on the board: {"src": "<file in story/images/>", text = caption}
Saves are optimistic: the client sends the version it loaded; a stale version is a conflict.
"""
from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path

from .projects import Projects
from .workspace import EditConflict

KINDS = ("section", "card", "note", "arrow", "image")
IMAGE_NAME = re.compile(r"^[A-Za-z0-9_-]{1,80}\.(png|jpg|gif|webp)$")
IMAGE_TYPES = {"png": "image/png", "jpg": "image/jpeg", "gif": "image/gif", "webp": "image/webp"}
COLORS = ("support", "counter", "caveat", "gap", "reviewer", "flow", "plain")
ITEM_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,40}$")
MAX_ITEMS = 800
MAX_TEXT = 4000
LIMIT = 100_000  # coordinates stay on a sane board


def _num(v, name: str, lo: float = -LIMIT, hi: float = LIMIT) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not (lo <= v <= hi):
        raise ValueError(f"{name} must be a number in [{lo}, {hi}]")
    return round(float(v), 1)


def validate_items(items) -> list[dict]:
    if not isinstance(items, list) or len(items) > MAX_ITEMS:
        raise ValueError(f"items must be a list of at most {MAX_ITEMS}")
    out, ids = [], set()
    for it in items:
        if not isinstance(it, dict):
            raise ValueError("every item must be an object")
        iid, kind = str(it.get("id", "")), it.get("kind")
        if not ITEM_ID.match(iid) or iid in ids:
            raise ValueError(f"bad or duplicate item id {iid!r}")
        if kind not in KINDS:
            raise ValueError(f"{iid}: unknown kind {kind!r}")
        ids.add(iid)
        if kind == "arrow":
            out.append({"id": iid, "kind": kind, "from": str(it.get("from", "")), "to": str(it.get("to", ""))})
            continue
        text = it.get("text", "")
        if not isinstance(text, str) or len(text) > MAX_TEXT:
            raise ValueError(f"{iid}: text must be a string of at most {MAX_TEXT} characters")
        d = {"id": iid, "kind": kind, "x": _num(it.get("x"), f"{iid}.x"), "y": _num(it.get("y"), f"{iid}.y"),
             "w": _num(it.get("w"), f"{iid}.w", 20, 10_000), "text": text}
        if kind != "note":
            d["h"] = _num(it.get("h"), f"{iid}.h", 20, 10_000)
        color = it.get("color", "plain")
        if color not in COLORS:
            raise ValueError(f"{iid}: unknown color {color!r}")
        if kind == "card" or color != "plain":
            d["color"] = color
        if kind == "image":
            src = str(it.get("src", ""))
            if not IMAGE_NAME.match(src):
                raise ValueError(f"{iid}: bad image src {src!r}")
            d["src"] = src
        if it.get("size") in ("small", "large", "title"):
            d["size"] = it["size"]
        out.append(d)
    # arrows must join items that exist (a deleted card takes its arrows with it on the client)
    return [d for d in out if d["kind"] != "arrow" or (d["from"] in ids and d["to"] in ids)]


class Story:
    def __init__(self, research_root: Path, projects: Projects | None = None):
        self.root = Path(research_root)
        self.projects = projects or Projects(self.root)
        self._lock = threading.Lock()

    def _dir(self, project: str) -> str:
        return self.projects.get(project).dir  # ValueError for a project not in projects.yaml

    def path(self, project: str) -> Path:
        return self.root / self._dir(project) / "story" / "canvas.json"

    def load(self, project: str) -> dict:
        p = self.path(project)
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {"project": project, "version": 0, "title": f"{project} story", "items": [], "file": self.rel(project)}
        except ValueError as exc:
            raise ValueError(f"{self.rel(project)} is not valid JSON ({exc}); fix it or ask the agent")
        return {"project": project, "version": int(d.get("version", 0)), "title": str(d.get("title", project)),
                "items": d.get("items", []), "file": self.rel(project)}

    def image_dir(self, project: str) -> Path:
        return self.path(project).parent / "images"

    def add_image(self, project: str, data: bytes) -> str:
        """Store an uploaded picture; returns the name to put in an image item's `src`."""
        import time, uuid
        from .agent import IMAGE_BYTES, _image_ext
        if len(data) > IMAGE_BYTES:
            raise ValueError(f"image larger than {IMAGE_BYTES // (1024 * 1024)} MB")
        ext = _image_ext(data)
        if ext is None:
            raise ValueError("only PNG, JPEG, GIF or WebP images")
        d = self.image_dir(project)
        d.mkdir(parents=True, exist_ok=True)
        name = f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}.{ext}"
        (d / name).write_bytes(data)
        return name

    def image_path(self, project: str, name: str) -> tuple[Path, str] | None:
        m = IMAGE_NAME.match(name)
        if not m:
            return None
        p = self.image_dir(project) / name
        return (p, IMAGE_TYPES[m.group(1)]) if p.is_file() else None

    def rel(self, project: str) -> str:
        return f"{self._dir(project)}/story/canvas.json"

    def save(self, project: str, version: int, items, title: str | None = None) -> dict:
        clean = validate_items(items)
        with self._lock:
            cur = self.load(project)
            if int(version) != cur["version"]:
                raise EditConflict(f"The canvas changed since you opened it (v{version} → v{cur['version']}); reloaded")
            doc = {"version": cur["version"] + 1, "title": (title or cur["title"])[:200], "items": clean}
            p = self.path(project)
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
            os.replace(tmp, p)
        return {**doc, "project": project, "file": self.rel(project)}
