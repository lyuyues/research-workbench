"""Meetings panel: weekly advisor 1:1 and group meeting (weekday and time in KINDS, local time RP_TZ).

Files (Research/meetings/, markdown is the source of truth):
  questions.md                      parking lot: "## Advisor" / "## Group" checkbox lists
  advisor/YYYY-MM-DD_slides.md      1-hour slides (Marp markdown, Alpha/meetings/README.md template)
  advisor/YYYY-MM-DD_slack.md       Slack progress update when the meeting is cancelled
  advisor/YYYY-MM-DD_notes.md       meeting notes (pasted Zoom summary / own notes)
  group/YYYY-MM-DD_slides.md        2 slides (done this week / plan next week) + speaking notes
  group/YYYY-MM-DD_notes.md
  <kind>/YYYY-MM-DD_zoom.md          Zoom AI summary, pulled from Gmail by jobs/meeting_recap.py (read-only)
  <kind>/YYYY-MM-DD_recap.md         Claude's draft recap (Slack/Notion + todos); "draft" until the user saves it
Earlier meetings in Alpha/meetings/ (slides_YYYYMMDD.md, advisor_meeting_YYYYMMDD.md) are listed as history.
Action items live in research_tasks.md as <P>-MEET<M><DD>-N (e.g. S-MEET801-2 = Aug 1).
"""
from __future__ import annotations

import os
import re
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo


from .projects import Projects

TZ = ZoneInfo(os.environ.get("RP_TZ", "UTC"))
KINDS = {
    "advisor": {"title": "Advisor meeting", "weekday": 0, "time": (10, 0), "minutes": 60},  # weekday 0 = Monday
    "group": {"title": "Group meeting", "weekday": 3, "time": (14, 0), "minutes": 60},
}
FILE = re.compile(r"^(\d{4}-\d{2}-\d{2})_(slides|slack|notes|zoom|recap)\.md$")
DRAFT = re.compile(r"^<!-- status: draft[^\n]*-->\n?")
LEGACY = re.compile(r"^(?:slides|advisor_meeting)_(\d{4})(\d{2})(\d{2})\.md$")
TASK = re.compile(r"^\s*- \[([ xX])\] ([A-Z]{1,4})-MEET(\d{1,2})(\d{2})-(\d+)\b\s*(.*)$")
QUESTIONS = "meetings/questions.md"
QUESTIONS_TEMPLATE = """# Meeting questions

> Things to bring up. Added from the Meetings panel (or by hand); tick when discussed.

## Advisor

## Group
"""
SECTION = {"advisor": "## Advisor", "group": "## Group"}


class MeetingConflict(Exception):
    pass


def next_meeting(kind: str, now: datetime | None = None) -> datetime:
    """The next occurrence that has not ended yet (so during the meeting it is still 'next')."""
    k = KINDS[kind]
    now = (now or datetime.now(TZ)).astimezone(TZ)
    d = now.date() + timedelta(days=(k["weekday"] - now.weekday()) % 7)
    start = datetime(d.year, d.month, d.day, *k["time"], tzinfo=TZ)
    if start + timedelta(minutes=k["minutes"]) <= now:
        start += timedelta(days=7)
    return start


def _atomic(p: Path, text: str) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(f".{p.name}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, p)


class Meetings:
    def __init__(self, research_root: Path, projects: Projects | None = None):
        self.root = Path(research_root)
        self.dir = self.root / "meetings"
        self.projects = projects or Projects(self.root)

    # ---------------------------------------------------------------- reads
    def _sessions(self, kind: str) -> dict[str, dict]:
        out: dict[str, dict] = {}
        d = self.dir / kind
        if d.is_dir():
            for f in d.iterdir():
                if m := FILE.match(f.name):
                    out.setdefault(m.group(1), {"date": m.group(1), "files": {}, "legacy": False})["files"][m.group(2)] = \
                        f"meetings/{kind}/{f.name}"
        for s in out.values():
            f = s["files"]
            s["status"] = ("held" if {"notes", "zoom", "recap"} & f.keys() else "cancelled" if "slack" in f
                           else "prepared" if "slides" in f else "planned")
            if "recap" in f:
                try:
                    head = (self.root / f["recap"]).read_text(encoding="utf-8")[:200]
                except OSError:
                    head = ""
                s["recap"] = "draft" if DRAFT.match(head) else "reviewed"
        return out

    def questions(self) -> list[dict]:
        p = self.root / QUESTIONS
        try:
            lines = p.read_text(encoding="utf-8").split("\n")
        except FileNotFoundError:
            return []
        out, kind = [], None
        for i, ln in enumerate(lines, 1):
            if ln.startswith("## "):
                kind = next((k for k, h in SECTION.items() if ln.strip() == h), None)
            elif kind and (m := re.match(r"^\s*- \[([ xX])\] (.*)$", ln)):
                out.append({"kind": kind, "line": i, "raw": ln, "checked": m.group(1) != " ", "text": m.group(2)})
        return out

    def action_items(self) -> dict[str, list[dict]]:
        """research_tasks.md MEET items grouped by meeting date (YYYY-MM-DD, year inferred: not in the future)."""
        try:
            lines = (self.root / "research_tasks.md").read_text(encoding="utf-8").split("\n")
        except FileNotFoundError:
            return {}
        today = datetime.now(TZ).date()
        out: dict[str, list[dict]] = {}
        seen = set()
        for i, ln in enumerate(lines, 1):
            m = TASK.match(ln)
            if not m:
                continue
            tid = f"{m.group(2)}-MEET{m.group(3)}{m.group(4)}-{m.group(5)}"
            if tid in seen:
                continue
            seen.add(tid)
            try:
                d = date(today.year, int(m.group(3)), int(m.group(4)))
            except ValueError:
                continue
            if d > today:
                d = d.replace(year=d.year - 1)
            out.setdefault(d.isoformat(), []).append({"id": tid, "line": i, "raw": ln, "checked": m.group(1) != " ",
                                                      "text": m.group(6).strip()})
        return out

    # ---------------------------------------------------------------- recap todos → tasks
    TODO_HEAD = re.compile(r"^## Todos(?: \([^)]*\))?\s*$")  # "## Todos" or "## Todos (<name>)"
    TODO = re.compile(r"^\s*- \[([ xX])\]\s+(.*\S)\s*$")
    def _proj_re(self) -> re.Pattern:
        names = "|".join(re.escape(p.name) for p in self.projects.all())
        return re.compile(rf"^({names + '|' if names else ''}Other|Lit(?:erature)?)\s*[:\uff1a]\s*", re.I)

    def recap_todos(self, kind: str, day: str) -> list[dict]:
        """Checkbox lines under "## Todos (the user)" in meetings/<kind>/<day>_recap.md."""
        rel = f"meetings/{kind}/{day}_recap.md"
        try:
            lines = (self.root / rel).read_text(encoding="utf-8").split("\n")
        except OSError:
            return []
        out, inside = [], False
        for i, ln in enumerate(lines, 1):
            if ln.startswith("## "):
                inside = bool(self.TODO_HEAD.match(ln))
                continue
            if inside and (m := self.TODO.match(ln)):
                out.append({"id": "", "line": i, "raw": ln, "checked": m.group(1) != " ", "text": m.group(2), "path": rel})
        return out

    def todos_to_tasks(self, kind: str, day: str) -> int:
        """Add the reviewed recap's todos to research_tasks.md as <P>-MEET<M><DD>-<n> under the project's section
        (one "### 🔴 <M>/<D> … Meeting Action Items" block per project). Lines already there are skipped."""
        todos = self.recap_todos(kind, day)
        if not todos:
            return 0
        p = self.root / "research_tasks.md"
        lines = p.read_text(encoding="utf-8").split("\n")
        d = date.fromisoformat(day)
        code = f"{d.month}{d.day:02d}"
        norm = lambda t: re.sub(r"\W+", " ", t).strip().lower()  # noqa: E731
        existing = {}
        for ln in lines:
            if (m := TASK.match(ln)) and f"{m.group(3)}{m.group(4)}" == code:
                existing.setdefault(m.group(2), {})[norm(m.group(6))] = int(m.group(5))
        section = {"O": "## Other", "L": "## Literature", **{p.code: f"## {p.name}" for p in self.projects.all()}}
        code_of = {p.name.lower(): p.code for p in self.projects.all()}
        proj_re = self._proj_re()
        title = f"{d.month}/{d.day} {KINDS[kind]['title'].split(' (')[0]} Action Items"
        added = 0
        for t in todos:
            m = proj_re.match(t["text"])
            proj = code_of.get((m.group(1) if m else "").lower(), "O")
            text = t["text"][m.end():] if m else t["text"]
            if norm(text) in existing.get(proj, {}):
                continue
            n = max(existing.get(proj, {}).values(), default=0) + 1
            existing.setdefault(proj, {})[norm(text)] = n
            item = f"- [{'x' if t['checked'] else ' '}] {proj}-MEET{code}-{n} {text}"
            # the block for this project: a "### … <title>" line after the project's "## " heading, before the next "## "
            top = next((i for i, ln in enumerate(lines) if ln.startswith(section[proj])), None)
            if top is None:
                lines += ["", section[proj], ""]
                top = len(lines) - 2
            end = next((i for i in range(top + 1, len(lines)) if lines[i].startswith("## ")), len(lines))
            head = next((i for i in range(top + 1, end) if lines[i].startswith("### ") and title in lines[i]), None)
            if head is None:
                block = [f"### 🔴 {title} → [recap](meetings/{kind}/{day}_recap.md)", item, ""]
                at = top + 1
                while at < end and not lines[at].strip():
                    at += 1
                lines[at:at] = block
            else:
                at = head + 1
                while at < len(lines) and lines[at].lstrip().startswith("- ["):
                    at += 1
                lines.insert(at, item)
            added += 1
        if added:
            _atomic(p, "\n".join(lines))
        return added

    def view(self, now: datetime | None = None) -> dict:
        now = (now or datetime.now(TZ)).astimezone(TZ)
        items = self.action_items()
        kinds = {}
        for kind, k in KINDS.items():
            sessions = self._sessions(kind)
            nxt = next_meeting(kind, now)
            day = nxt.date().isoformat()
            current = sessions.get(day, {"date": day, "files": {}, "legacy": False, "status": "planned"})
            past = sorted((s for d, s in sessions.items() if d < day), key=lambda s: s["date"], reverse=True)
            last_held = next((s["date"] for s in past if s["status"] in ("held", "prepared")), None)
            kinds[kind] = {"title": k["title"], "next": int(nxt.timestamp() * 1000), "next_date": day,
                           "current": current, "history": past[:30], "last": last_held}
        # action items from the most recent advisor meeting that produced any (or the last two)
        groups = [{"date": d, "items": [{**i, "path": "research_tasks.md"} for i in items[d]], "source": "tasks"}
                  for d in sorted(items, reverse=True)[:12]]
        for kind in KINDS:  # recaps whose todos are not tasks yet (draft, or reviewed before this existed)
            for day, sess in self._sessions(kind).items():
                if "recap" not in sess["files"] or day in items or (now.date() - date.fromisoformat(day)).days > 30:
                    continue
                todos = self.recap_todos(kind, day)
                if todos:
                    groups.append({"date": day, "items": todos, "source": "recap", "draft": sess.get("recap") == "draft",
                                   "kind": kind})
        groups.sort(key=lambda g: g["date"], reverse=True)
        return {"kinds": kinds, "questions": self.questions(), "questions_path": QUESTIONS,
                "action_items": groups,
                "now": int(now.timestamp() * 1000)}

    # ---------------------------------------------------------------- writes
    def add_question(self, kind: str, text: str, today: date | None = None) -> None:
        if kind not in SECTION:
            raise ValueError("kind must be advisor or group")
        text = " ".join(text.split())
        if not text:
            raise ValueError("empty question")
        p = self.root / QUESTIONS
        try:
            lines = p.read_text(encoding="utf-8").split("\n")
        except FileNotFoundError:
            lines = QUESTIONS_TEMPLATE.split("\n")
        head = next((i for i, ln in enumerate(lines) if ln.strip() == SECTION[kind]), None)
        if head is None:
            lines += ["", SECTION[kind]]
            head = len(lines) - 1
        end = head + 1
        while end < len(lines) and not lines[end].startswith("## "):
            end += 1
        last = max((i for i in range(head + 1, end) if lines[i].strip()), default=head)
        stamp = (today or datetime.now(TZ).date()).isoformat()
        lines.insert(last + 1, f"- [ ] {text} _(added {stamp})_")
        _atomic(p, "\n".join(lines))

    def save_notes(self, kind: str, day: str, text: str, expect: str, which: str = "notes") -> str:
        """Save a meeting's notes / slides / Slack message / recap (markdown), refusing if it changed since it was
        opened. Saving a recap drops its "draft" marker: the user has reviewed it."""
        if which not in ("notes", "slides", "slack", "recap"):
            raise ValueError("which must be notes, slides, slack or recap")
        if kind not in KINDS:
            raise ValueError("unknown meeting kind")
        try:
            date.fromisoformat(day)
        except ValueError:
            raise ValueError("bad date")
        # Edit the notes file that already exists for that meeting (older advisor notes live in Alpha/meetings/)
        rel = self._sessions(kind).get(day, {}).get("files", {}).get(which) or f"meetings/{kind}/{day}_{which}.md"
        p = self.root / rel
        current = p.read_text(encoding="utf-8") if p.exists() else ""
        if current != expect:
            raise MeetingConflict(f"the {which} changed since you opened them — reload and try again")
        if not text.strip():
            raise ValueError(f"{which} are empty")
        if which == "recap":
            text = DRAFT.sub("", text.lstrip(), count=1)
        if which == "notes" and not text.lstrip().startswith("#"):
            text = f"# {KINDS[kind]['title']} — {day}\n\n{text}"
        _atomic(p, text.rstrip() + "\n")
        return rel
