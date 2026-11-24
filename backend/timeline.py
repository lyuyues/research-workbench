"""Timeline: dated events + backward-planned paper tracks, from Research/timeline.md (markdown = source of truth).

  ## Paper A → Journal X (2027-02-01)          a heading with a (YYYY-MM-DD) is a *track*: milestones planned
  - [ ] 2026-11-30 Data collection closed  backward from that target; progress = done vs. due-by-today
  - [x] 2026-11-20 10:00 Something #tag — note
  ## Venues                               a heading without a date is a plain group (events, venue deadlines)
  - 2027-01-18 DIS 2027 full paper — est. #venue

Checkbox optional ([x] = done). Time optional (local time, RP_TZ). `#tag` words become tags; text after " — " is a note.
"""
from __future__ import annotations

import os
import re
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

TZ = ZoneInfo(os.environ.get("RP_TZ", "UTC"))
PATH = "timeline.md"
ITEM = re.compile(r"^\s*-\s+(?:\[([ xX])\]\s+)?(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}))?\s+(.+?)\s*$")
HEAD = re.compile(r"^##\s+(.+?)\s*$")
TARGET = re.compile(r"\((\d{4}-\d{2}-\d{2})\)\s*$")
TAG = re.compile(r"(?<!\S)#([\w-]+)")


def _date(s: str) -> date | None:
    try:
        return date.fromisoformat(s)
    except ValueError:
        return None


def parse(text: str, today: date) -> list[dict]:
    """Groups in file order; each {title, target, days, items}. Items before any heading go to group 'Events'."""
    groups: list[dict] = []
    cur = None
    for i, ln in enumerate(text.split("\n"), 1):
        if h := HEAD.match(ln):
            title = h.group(1)
            t = TARGET.search(title)
            target = _date(t.group(1)) if t else None
            cur = {"title": TARGET.sub("", title).strip() if target else title, "line": i,
                   "target": target.isoformat() if target else None,
                   "days": (target - today).days if target else None, "items": []}
            groups.append(cur)
            continue
        m = ITEM.match(ln)
        if not m or not (d := _date(m.group(2))):
            continue
        if cur is None:
            cur = {"title": "Events", "line": 0, "target": None, "days": None, "items": []}
            groups.append(cur)
        rest = m.group(4)
        tags = TAG.findall(rest)
        title, _, note = (s.strip() for s in TAG.sub("", rest).strip().partition(" — "))
        done = (m.group(1) or " ") != " "
        days = (d - today).days
        cur["items"].append({"line": i, "raw": ln, "checkbox": m.group(1) is not None, "checked": done,
                             "date": d.isoformat(), "time": m.group(3), "title": title, "note": note or None,
                             "tags": tags, "done": done, "days": days,
                             "overdue": m.group(1) is not None and not done and days < 0})
    for g in groups:
        g["items"].sort(key=lambda e: (e["date"], e["time"] or ""))
        if g["target"]:
            ms = [e for e in g["items"] if e["checkbox"]]
            g["progress"] = {"done": sum(e["done"] for e in ms), "total": len(ms),
                             "due": sum(e["days"] < 0 for e in ms),
                             "overdue": sum(e["overdue"] for e in ms),
                             "next": next((e for e in ms if not e["done"]), None)}
    return groups


class Timeline:
    def __init__(self, research_root: Path):
        self.root = Path(research_root)

    def view(self, now: datetime | None = None) -> dict:
        today = (now or datetime.now(TZ)).astimezone(TZ).date()
        try:
            text = (self.root / PATH).read_text(encoding="utf-8")
        except FileNotFoundError:
            return {"available": False, "path": PATH, "today": today.isoformat(), "groups": []}
        return {"available": True, "path": PATH, "today": today.isoformat(), "groups": parse(text, today)}


def calendar_group(events: list[dict], today: date) -> dict:
    """Google Calendar events as a read-only timeline group (topic "Calendar")."""
    items = []
    for n, e in enumerate(events):
        start = e.get("start") or ""
        if e.get("all_day") or len(start) == 10:
            d, t = _date(start[:10]), None
        else:
            try:
                dt = datetime.fromisoformat(start.replace("Z", "+00:00")).astimezone(TZ)
            except ValueError:
                continue
            d, t = dt.date(), dt.strftime("%H:%M")
        if d is None:
            continue
        days = (d - today).days
        items.append({"line": -(n + 1), "raw": "", "checkbox": False, "checked": False, "date": d.isoformat(), "time": t,
                      "title": e.get("title") or "(no title)", "note": e.get("location") or None, "tags": [],
                      "done": False, "days": days, "overdue": False, "link": e.get("link")})
    items.sort(key=lambda e: (e["date"], e["time"] or ""))
    return {"title": "Calendar", "line": -1, "target": None, "days": None, "items": items, "source": "google"}
