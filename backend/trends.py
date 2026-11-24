"""Trends panel: daily frontier feed written by Research/tools/trends_fetch.py (+ Claude's
Chinese one-liners in YYYY-MM-DD.ai.json), and the editable topic / source config."""
from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path

DAY_FILE = re.compile(r"^(\d{4}-\d{2}-\d{2})\.json$")
KINDS = ("academic", "lab", "hcilab", "industry", "community")
WATCH = ("feed", "page")  # feed = RSS/Atom; page = watch a web page for new links (labs without a feed)
TOPIC_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
MAX_KEYWORDS = 40
MAX_SAVED = 500
SAVED_FIELDS = ("id", "title", "url", "source", "kind", "published", "zh", "why", "relevance", "topics", "snippet", "authors")


def _json(p: Path) -> dict | None:
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else None
    except (OSError, ValueError):
        return None


def validate_config(cfg: dict) -> dict:
    """Normalized config, or ValueError with a message the panel can show."""
    if not isinstance(cfg, dict):
        raise ValueError("config must be an object")
    topics, seen = [], set()
    for t in cfg.get("topics") or []:
        name = str(t.get("name", "")).strip()
        if not name:
            raise ValueError("every topic needs a name")
        tid = str(t.get("id") or re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "topic")[:32]
        if not TOPIC_ID.match(tid) or tid in seen:
            raise ValueError(f"bad or duplicate topic id {tid!r}")
        seen.add(tid)
        kws = [str(k).strip() for k in t.get("keywords") or [] if str(k).strip()]
        if not kws:
            raise ValueError(f"topic {name!r} needs at least one keyword")
        topics.append({"id": tid, "name": name[:60], "keywords": kws[:MAX_KEYWORDS]})
    if not topics:
        raise ValueError("track at least one topic")
    sources = []
    for s in cfg.get("sources") or []:
        name, url = str(s.get("name", "")).strip(), str(s.get("url", "")).strip()
        if not name or not re.match(r"^https?://[^\s]+$", url):
            raise ValueError(f"source {name or url!r} needs a name and an http(s) feed URL")
        kind = s.get("kind", "industry")
        if kind not in KINDS:
            raise ValueError(f"source {name!r}: kind must be one of {KINDS}")
        watch = s.get("watch") or "feed"
        if watch not in WATCH:
            raise ValueError(f"source {name!r}: watch must be one of {WATCH}")
        sources.append({"name": name[:80], "url": url, "kind": kind, "watch": watch, "all": bool(s.get("all")),
                        "enabled": bool(s.get("enabled", True))})
    ax = cfg.get("arxiv") or {}
    cats = [c.strip() for c in ax.get("categories") or [] if re.match(r"^[a-z-]+(\.[A-Za-z-]+)?$", str(c).strip())]
    hn = cfg.get("hn") or {}
    return {"topics": topics,
            "arxiv": {"enabled": bool(ax.get("enabled", True)), "categories": cats or ["cs.HC", "cs.AI"],
                      "max_per_topic": max(5, min(int(ax.get("max_per_topic", 40)), 100))},
            "hn": {"enabled": bool(hn.get("enabled", True)), "min_points": max(0, min(int(hn.get("min_points", 30)), 1000))},
            "sources": sources}


class Trends:
    def __init__(self, research_root: Path):
        self.dir = Path(research_root) / "trends"
        self.data = self.dir / "data"
        self.config_path = self.dir / "config.json"
        self.saved_path = self.dir / "saved.json"  # "save for later" items, kept across days (web UI state, not journaled)
        self._lock = threading.Lock()

    def days(self) -> list[str]:
        try:
            return sorted((m.group(1) for f in self.data.iterdir() if (m := DAY_FILE.match(f.name))), reverse=True)
        except OSError:
            return []

    def config(self) -> dict | None:
        return _json(self.config_path)

    def view(self, day: str | None = None) -> dict:
        days = self.days()
        if day is not None and day not in days:
            raise ValueError("no trends for that day")
        day = day or (days[0] if days else None)
        out = {"days": days, "day": day, "config": self.config(), "items": [], "headline": None, "saved": self.saved(),
               "errors": [], "generated": None, "summarized": False}
        if not day:
            return out
        raw = _json(self.data / f"{day}.json") or {}
        ai = _json(self.data / f"{day}.ai.json") or {}
        notes = ai.get("items") if isinstance(ai.get("items"), dict) else {}
        items = []
        for x in raw.get("items") or []:
            n = notes.get(x.get("id")) or {}
            items.append({**x, "zh": n.get("zh"), "relevance": n.get("relevance"), "why": n.get("why") or None})
        out.update(items=items, headline=ai.get("headline"), errors=raw.get("errors") or [],
                   generated=raw.get("generated"), summarized=bool(notes))
        return out

    def saved(self) -> list[dict]:
        d = _json(self.saved_path) or {}
        return [x for x in d.get("items") or [] if isinstance(x, dict) and x.get("id")]

    def set_saved(self, item: dict, on: bool, day: str | None = None) -> list[dict]:
        """Save (snapshot of the item, so it survives the day file) or unsave by id; newest first."""
        iid = str(item.get("id", "")).strip()[:300]
        if not iid:
            raise ValueError("item needs an id")
        with self._lock:
            items = [x for x in self.saved() if x["id"] != iid]
            if on:
                url = str(item.get("url", "")).strip()
                title = str(item.get("title", "")).strip()
                if not title or not re.match(r"^https?://\S+$", url):
                    raise ValueError("item needs a title and an http(s) URL")
                snap = {k: item.get(k) for k in SAVED_FIELDS if item.get(k) is not None}
                snap.update(id=iid, title=title[:400], url=url[:2000], day=day, saved_at=int(time.time() * 1000))
                for k in ("zh", "why", "snippet"):
                    if isinstance(snap.get(k), str):
                        snap[k] = snap[k][:2000]
                items.insert(0, snap)
            if len(items) > MAX_SAVED:
                raise ValueError(f"at most {MAX_SAVED} saved items — unsave some first")
            self.dir.mkdir(parents=True, exist_ok=True)
            tmp = self.saved_path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps({"items": items}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
            os.replace(tmp, self.saved_path)
            return items

    def save_config(self, cfg: dict) -> dict:
        clean = validate_config(cfg)
        self.dir.mkdir(parents=True, exist_ok=True)
        tmp = self.config_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(clean, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, self.config_path)
        return clean
