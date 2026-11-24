"""Read-mostly views of the Research folder for the Today / Projects / Literature / Annotations /
Writing / Weekly panels. Markdown files stay the source of truth: every parser is tolerant (a
broken file only empties its own card) and every edit is a minimal, verified line change.
"""
from __future__ import annotations

import json
import os
import re
import time
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from .projects import Projects

TZ = ZoneInfo(os.environ.get("RP_TZ", "UTC"))
CHECK = re.compile(r"^(\s*)- \[( |x|X)\] (.*)$")
H2 = re.compile(r"^## (.+?)\s*$")
H3 = re.compile(r"^### (.+?)\s*$")
DATE_H = re.compile(r"^## (\d{4}-\d{2}-\d{2})\b(.*)$")

# daily_tracker.md section headings -> kind (first match wins, case-insensitive substring match):
# "### Tasks", "### Habits", "### Notes for Claude", "### Claude reply".
SECTION_WORDS = [("reply", ("reply",)), ("habits", ("habit",)), ("tasks", ("task",)), ("message", ("note", "message"))]


def section_kind(title: str) -> str:
    """Kind of a daily_tracker '### ' section: habits | tasks | message | reply | other."""
    t = title.lower()  # "Claude reply" is checked first, so it never counts as notes
    return next((k for k, words in SECTION_WORDS if any(w in t for w in words)), "other")
TEXT_EXT = {".md", ".tex", ".txt", ".yaml", ".yml", ".json", ".jsonl", ".csv", ".bib"}
MAX_TEXT = 2_000_000


def today_local() -> date:
    return datetime.now(TZ).date()


def _read(p: Path) -> str | None:
    try:
        return p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def _mtime(p: Path) -> int | None:
    try:
        return int(p.stat().st_mtime * 1000)
    except OSError:
        return None


def title_date(title: str, today: date | None = None) -> str | None:
    """Date mentioned in a heading: 2026-10-13, or M/D (most recent such day not after today)."""
    today = today or today_local()
    m = re.search(r"(20\d\d)-(\d{2})-(\d{2})", title)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3))).isoformat()
        except ValueError:
            return None
    m = re.search(r"(?<![\d/])(\d{1,2})/(\d{1,2})(?![\d/])", title)
    if m:
        for y in (today.year, today.year - 1):
            try:
                d = date(y, int(m.group(1)), int(m.group(2)))
            except ValueError:
                return None
            if d <= today:
                return d.isoformat()
    return None


def checkbox(line: str, n: int) -> dict | None:
    m = CHECK.match(line)
    if not m:
        return None
    return {"line": n, "text": m.group(3).strip(), "checked": m.group(2) != " ", "indent": len(m.group(1)),
            "raw": line}


# ---------------------------------------------------------------- edits


class EditConflict(Exception):
    """The file changed under us (line moved/edited) — the UI must reload."""


class Workspace:
    def __init__(self, root: Path, projects: Projects | None = None):
        self.projects = projects or Projects(Path(root))
        self.root = Path(root)

    # -- paths
    def resolve(self, rel: str, *, must_exist: bool = True) -> Path:
        if not rel or rel.startswith("/") or "\\" in rel or "\x00" in rel:
            raise ValueError("bad path")
        if any(part.startswith(".") or part == ".." for part in Path(rel).parts):
            raise ValueError("bad path")
        p = (self.root / rel).resolve()
        if not p.is_relative_to(self.root.resolve()):
            raise ValueError("bad path")
        if must_exist and not p.is_file():
            raise ValueError("not found")
        return p

    def read_text(self, rel: str) -> dict:
        p = self.resolve(rel)
        if p.suffix.lower() not in TEXT_EXT:
            raise ValueError("not a text file")
        if p.stat().st_size > MAX_TEXT:
            raise ValueError("file too large")
        return {"path": rel, "text": _read(p) or "", "mtime": _mtime(p)}

    def _lines(self, rel: str) -> tuple[Path, list[str]]:
        p = self.resolve(rel)
        if p.suffix.lower() != ".md":
            raise ValueError("only markdown files can be edited here")
        return p, p.read_text(encoding="utf-8").split("\n")

    @staticmethod
    def _write(p: Path, lines: list[str]) -> None:
        tmp = p.with_name(f".{p.name}.rp-tmp")
        tmp.write_text("\n".join(lines), encoding="utf-8")
        os.replace(tmp, p)

    def set_checkbox(self, rel: str, line: int, expect: str, checked: bool) -> dict:
        """Tick/untick `- [ ]` on 1-based `line`, only if that line still reads `expect`."""
        p, lines = self._lines(rel)
        if not (1 <= line <= len(lines)) or lines[line - 1].rstrip("\r") != expect.rstrip("\r"):
            raise EditConflict("the file changed since it was loaded — reload and try again")
        m = CHECK.match(lines[line - 1])
        if not m:
            raise ValueError("not a checkbox line")
        lines[line - 1] = f"{m.group(1)}- [{'x' if checked else ' '}] {m.group(3)}"
        self._write(p, lines)
        return {"line": line, "raw": lines[line - 1]}

    TASK_ID = re.compile(r"^([A-Z]{1,4}-(?:MEET\d{3,4}-\d+|[A-Z]{1,6}-\d+[a-z]?|\d+(?:\.\d+)+))\s")

    def add_today_task(self, text: str) -> dict:
        """Put a task (e.g. dragged from the open 🔴 tasks) into today's task section in daily_tracker.md, before the
        "(add your own here)" placeholder. Refuses a task ID that is already on today's list."""
        text = " ".join(text.split())
        if not text:
            raise ValueError("empty task")
        p, lines = self._lines("daily_tracker.md")
        today = today_local().isoformat()
        start = next((i for i, ln in enumerate(lines) if ln.startswith(f"## {today}")), None)
        if start is None:
            raise ValueError("no entry for today yet (the 7:00 check writes it)")
        end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("## ")), len(lines))
        sec = next((i for i in range(start + 1, end) if lines[i].startswith("### ") and section_kind(lines[i]) == "tasks"), None)
        if sec is None:
            raise ValueError("today's entry has no task list")
        sec_end = next((i for i in range(sec + 1, end) if lines[i].startswith("### ")), end)
        tid = self.TASK_ID.match(text)
        if tid and any(tid.group(1) in ln for ln in lines[sec:sec_end]):
            raise EditConflict(f"{tid.group(1)} is already on today's list")
        ph = next((i for i in range(sec + 1, sec_end) if "add your own here" in lines[i]), None)
        last = max((i for i in range(sec + 1, sec_end) if CHECK.match(lines[i])), default=sec)
        at = ph if ph is not None else last + 1
        lines.insert(at, f"- [ ] {text}")
        self._write(p, lines)
        return {"line": at + 1}

    def remove_today_task(self, line: int, expect: str) -> None:
        """Take a line out of today's task section (dragged back to All open). A tracked task stays in research_tasks.md
        (and so in All open); a line Claude wrote just for today is simply dropped."""
        p, lines = self._lines("daily_tracker.md")
        if not (1 <= line <= len(lines)) or lines[line - 1].rstrip("\r") != expect.rstrip("\r"):
            raise EditConflict("the file changed since it was loaded — reload and try again")
        if not CHECK.match(lines[line - 1]) or "add your own here" in lines[line - 1]:
            raise ValueError("not a task line")
        today = today_local().isoformat()
        start = next((i for i, ln in enumerate(lines) if ln.startswith(f"## {today}")), None)
        end = next((i for i in range((start or 0) + 1, len(lines)) if lines[i].startswith("## ")), len(lines))
        sec = next((i for i in range((start or 0) + 1, end) if lines[i].startswith("### ") and section_kind(lines[i]) == "tasks"), None)
        if start is None or sec is None or not (sec < line - 1 < end) or any(
                lines[i].startswith("### ") for i in range(sec + 1, line - 1)):
            raise ValueError("only lines in today's task list can be removed")
        del lines[line - 1]
        self._write(p, lines)

    def sync_task_tick(self, raw: str, checked: bool) -> str | None:
        """A Today's-tasks line that starts with a task ID ("- [ ] S-AN-6 …") ticks the same task in research_tasks.md."""
        m = CHECK.match(raw)
        tid = self.TASK_ID.match(m.group(3)) if m else None
        if not tid:
            return None
        p, lines = self._lines("research_tasks.md")
        for i, ln in enumerate(lines):
            mm = CHECK.match(ln)
            if mm and self.TASK_ID.match(mm.group(3)) and self.TASK_ID.match(mm.group(3)).group(1) == tid.group(1):
                want = f"{mm.group(1)}- [{'x' if checked else ' '}] {mm.group(3)}"
                if want != ln:
                    lines[i] = want
                    self._write(p, lines)
                return tid.group(1)
        return None

    def replace_message(self, header_line: int, end_line: int, end_raw: str, text: str) -> None:
        """Rewrite the quote lines of the notes-for-Claude section in daily_tracker.md (the user editing their own notes).
        Empty text leaves a single ">" so the section stays in place."""
        p, lines = self._lines("daily_tracker.md")
        if not (1 <= header_line <= len(lines)) or section_kind(lines[header_line - 1]) != "message":
            raise EditConflict("the tracker changed — reload and try again")
        if not (header_line <= end_line <= len(lines)) or lines[end_line - 1].rstrip("\r") != end_raw.rstrip("\r"):
            raise EditConflict("the tracker changed — reload and try again")
        if any(ln.strip() and not ln.startswith(">") for ln in lines[header_line:end_line]):
            raise EditConflict("the notes changed — reload and try again")
        body = [ln.rstrip() for ln in text.strip().splitlines()]
        new = [f"> {ln}" if ln else ">" for ln in body] or [">"]
        lines[header_line:end_line] = new
        self._write(p, lines)

    def append_quote(self, rel: str, after_line: int, expect: str, text: str, prefix: str = "") -> None:
        """Insert `> {prefix}{text}` lines after 1-based `after_line` (verified by its content)."""
        p, lines = self._lines(rel)
        if not (1 <= after_line <= len(lines)) or lines[after_line - 1].rstrip("\r") != expect.rstrip("\r"):
            raise EditConflict("the file changed since it was loaded — reload and try again")
        body = [ln.rstrip() for ln in text.strip().splitlines()] or [""]
        new = [f"> {prefix}{body[0]}"] + [f"> {ln}" if ln else ">" for ln in body[1:]]
        lines[after_line:after_line] = new
        self._write(p, lines)

    # ------------------------------------------------------------ Today

    def daily(self, limit: int = 14) -> dict:
        p = self.root / "daily_tracker.md"
        text = _read(p)
        if text is None:
            return {"available": False, "entries": [], "today": today_local().isoformat()}
        lines = text.split("\n")
        entries: list[dict] = []
        cur = sec = None
        for i, line in enumerate(lines, 1):
            m = DATE_H.match(line)
            if m:
                if len(entries) >= limit:
                    break
                cur = {"date": m.group(1), "title": line[3:].strip(), "line": i, "sections": []}
                entries.append(cur)
                sec = None
                continue
            if cur is None:
                continue
            if H2.match(line):
                cur = None
                continue
            m3 = H3.match(line)
            if m3:
                sec = {"title": m3.group(1), "line": i, "items": [], "quote": [], "last_line": i}
                cur["sections"].append(sec)
                continue
            if sec is None:
                continue
            cb = checkbox(line, i)
            if cb:
                sec["items"].append(cb)
                sec["last_line"] = i
            elif line.startswith(">"):
                sec["quote"].append(line[1:].strip())
                sec["last_line"] = i
        for e in entries:
            for s in e["sections"]:
                s["quote"] = "\n".join(s["quote"]).strip()
                s["kind"] = section_kind(s["title"])
                s["last_raw"] = lines[s["last_line"] - 1]
        return {"available": True, "path": "daily_tracker.md", "mtime": _mtime(p),
                "today": today_local().isoformat(), "entries": entries}

    def habit_rates(self, start: date, end: date) -> list[dict]:
        """Per-habit completion between start and end (inclusive) from daily_tracker entries."""
        data = self.daily(limit=400)
        stats: dict[str, list[int]] = defaultdict(lambda: [0, 0])
        days = 0
        for e in data["entries"]:
            d = date.fromisoformat(e["date"])
            if not (start <= d <= end):
                continue
            days += 1
            for s in e["sections"]:
                if s["kind"] == "habits":
                    for it in s["items"]:
                        key = re.sub(r"[-–]\s*[\d:;.]+$", "", it["text"]).strip()
                        stats[key][1] += 1
                        stats[key][0] += it["checked"]
        return [{"habit": k, "done": v[0], "of": v[1]} for k, v in stats.items()]

    # ------------------------------------------------------------ Projects / tasks

    def tasks(self) -> dict:
        p = self.root / "research_tasks.md"
        text = _read(p)
        if text is None:
            return {"available": False}
        lines = text.split("\n")
        dashboard: list[dict] = []
        groups: list[dict] = []
        g = ms = None
        in_dash = stop = False
        for i, line in enumerate(lines, 1):
            m2 = H2.match(line)
            if m2:
                title = m2.group(1)
                in_dash = title.lower().startswith("dashboard")
                if title.lower().startswith(("progress log", "archive")):
                    stop = True
                    continue
                stop = False
                g = None if in_dash else {"title": title, "line": i, "milestones": []}
                if g:
                    groups.append(g)
                ms = None
                continue
            if stop:
                continue
            if in_dash and line.startswith("|"):
                cells = [c.strip() for c in line.strip().strip("|").split("|")]
                if cells and not set("".join(cells)) <= set("-: "):
                    dashboard.append({"cells": cells})
                continue
            if g is None:
                continue
            m3 = H3.match(line)
            if m3:
                ms = {"title": m3.group(1), "line": i, "items": [], "notes": []}
                g["milestones"].append(ms)
                continue
            cb = checkbox(line, i)
            if cb:
                if ms is None:
                    ms = {"title": "", "line": i, "items": [], "notes": []}
                    g["milestones"].append(ms)
                m = re.match(r"^\*{0,2}([A-Z]+-[A-Za-z0-9.\-]+)\*{0,2}\s", cb["text"])
                cb["id"] = m.group(1) if m else None
                ms["items"].append(cb)
            elif ms is not None and line.strip().startswith("- **") and not line.strip().startswith("- ["):
                ms["notes"].append(line.strip()[2:])
        for g in groups:
            for ms in g["milestones"]:
                ms["open"] = sum(not it["checked"] for it in ms["items"])
                ms["done"] = sum(it["checked"] for it in ms["items"])
                ms["status"] = next((e for e in ("🔴", "🟡", "🔵", "✅", "⬜") if e in ms["title"]), None)
                ms["date"] = title_date(ms["title"])
        header, rows = (dashboard[0]["cells"], [r["cells"] for r in dashboard[1:]]) if dashboard else ([], [])
        upd = re.search(r"Updated:\s*([0-9-]+)", text)
        return {"available": True, "path": "research_tasks.md", "mtime": _mtime(p),
                "updated": upd.group(1) if upd else None,
                "dashboard": {"header": header, "rows": rows}, "groups": groups}

    def progress_log(self, limit: int = 12) -> list[dict]:
        text = _read(self.root / "research_tasks.md") or ""
        out, cur, on = [], None, False
        for line in text.split("\n"):
            if H2.match(line):
                on = line.lower().startswith("## progress log")
                continue
            if not on:
                continue
            m = re.match(r"^\*\*(.+?)\*\*\s*$", line.strip())
            if m:
                if len(out) >= limit:
                    break
                cur = {"title": m.group(1), "lines": []}
                out.append(cur)
            elif cur is not None and line.strip():
                cur["lines"].append(line.rstrip())
        return [{"title": e["title"], "text": "\n".join(e["lines"])} for e in out]

    def project_links(self) -> dict:
        """project_links.json: {"<project name>": {"notion": "https://…", ...}} — links shown next to project names."""
        try:
            raw = json.loads((self.root / "project_links.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        out = {}
        for name, links in (raw.items() if isinstance(raw, dict) else []):
            if isinstance(links, dict):
                ok = {k: v for k, v in links.items() if isinstance(v, str) and v.startswith("https://")}
                if ok:
                    out[str(name)] = ok
        return out

    def portfolio(self) -> dict:
        t = self.root / "_tracker"
        out: dict = {"available": False}
        try:
            pf = json.loads((t / "portfolio.json").read_text())
            out.update(available=True, generated_at=pf.get("generated_at"), headline=pf.get("headline"),
                       projects=pf.get("projects", []), links=pf.get("links", []),
                       shared=pf.get("shared", []), issues=pf.get("issues", []))
        except (OSError, ValueError):
            pass
        try:
            lr = json.loads((t / "last_result.json").read_text())
            projs = lr.get("projects", {})
            out["timelines"] = {k: {"headline": v.get("headline"), "stages": v.get("stages", []),
                                    "events": v.get("events", [])[-40:], "generated_at": v.get("generated_at")}
                                for k, v in projs.items() if isinstance(v, dict)}
            out["available"] = True
        except (OSError, ValueError, AttributeError):
            out.setdefault("timelines", {})
        return out

    # ------------------------------------------------------------ Literature

    def literature(self, digest: str | None = None) -> dict:
        d = self.root / "literature-radar" / "digests"
        names = sorted((f.name for f in d.glob("*-weekly.md")), reverse=True) if d.is_dir() else []
        if digest is not None and digest not in names:
            raise ValueError("unknown digest")
        name = digest or (names[0] if names else None)
        out: dict = {"digests": names, "digest": name, "groups": [], "intro": ""}
        if name:
            rel = f"literature-radar/digests/{name}"
            out["path"] = rel
            lines = (_read(d / name) or "").split("\n")
            g = paper = None
            intro: list[str] = []
            for i, line in enumerate(lines, 1):
                m2 = H2.match(line)
                if m2:
                    g = {"title": m2.group(1), "papers": []}
                    out["groups"].append(g)
                    paper = None
                    continue
                m3 = H3.match(line)
                if m3 and g is not None:
                    paper = {"title": m3.group(1), "line": i, "read": None, "fields": {}, "links": [], "body": []}
                    g["papers"].append(paper)
                    continue
                if g is None:
                    if line.strip() and not line.startswith("# "):
                        intro.append(line)
                    continue
                if paper is None:
                    continue
                cb = checkbox(line, i)
                if cb and paper["read"] is None:
                    paper["read"] = cb
                    continue
                lm = re.match(r"^→ \[(.+?)\]\((.+?)\)", line.strip())
                if lm:
                    target = os.path.normpath(os.path.join("literature-radar/digests", lm.group(2).split("#")[0]))
                    paper["links"].append({"label": lm.group(1), "path": target,
                                           "anchor": lm.group(2).split("#", 1)[1] if "#" in lm.group(2) else None})
                    continue
                fm = re.match(r"^- \*\*(.+?)\*\*:\s*(.*)$", line)
                if fm:
                    paper["fields"][fm.group(1)] = fm.group(2)
                elif line.strip():
                    paper["body"].append(line)
            out["intro"] = "\n".join(intro).strip()
            for g in out["groups"]:
                for p in g["papers"]:
                    p["body"] = "\n".join(p["body"]).strip()
                    doi = re.search(r"\((https://doi\.org/[^)]+)\)", p["fields"].get("DOI", ""))
                    p["doi"] = doi.group(1) if doi else None
        notes = self.root / "literature-radar" / "reading-notes"
        out["notes"] = sorted(({"name": f.name, "path": f"literature-radar/reading-notes/{f.name}", "mtime": _mtime(f)}
                               for f in notes.glob("*.md")), key=lambda x: -(x["mtime"] or 0))[:40] \
            if notes.is_dir() else []
        rl = self.root / "reading_log"
        out["reading_log"] = sorted(({"name": f.name, "path": f"reading_log/{f.name}", "mtime": _mtime(f)}
                                     for f in rl.glob("*.md")), key=lambda x: x["name"], reverse=True)[:40] \
            if rl.is_dir() else []
        return out

    # ------------------------------------------------------------ Annotations

    ANNOT_EXTRA = ("documents",)

    @property
    def ANNOT_DIRS(self) -> tuple[str, ...]:  # noqa: N802 — project folders (projects.yaml) + shared folders
        return (*dict.fromkeys(p.dir.split("/")[0] for p in self.projects.all()), *self.ANNOT_EXTRA)
    ANNOT_SKIP = ("_archive", "archived", "node_modules", "overleaf", "web-demo", "documents/workflow/plans")
    ANNOT_HEAD = re.compile(r"^>\s*⚠️\s*\*\*Question for you\*\*\s*(.*)$")

    def annotations(self) -> dict:
        blocks: list[dict] = []
        for top in self.ANNOT_DIRS:
            base = self.root / top
            if not base.is_dir():
                continue
            for dirpath, dirnames, filenames in os.walk(base):
                rel_dir = Path(dirpath).relative_to(self.root).as_posix()
                dirnames[:] = [d for d in dirnames if not d.startswith(".")
                               and not any(s in f"{rel_dir}/{d}" for s in self.ANNOT_SKIP)]
                for fn in filenames:
                    if not fn.endswith(".md") or "conflicted copy" in fn:
                        continue
                    f = Path(dirpath) / fn
                    try:
                        if f.stat().st_size > MAX_TEXT:
                            continue
                        text = f.read_text(encoding="utf-8", errors="replace")
                    except OSError:
                        continue
                    if "Question for you" not in text:
                        continue
                    blocks += self._blocks(f.relative_to(self.root).as_posix(), text.split("\n"), _mtime(f))
        blocks.sort(key=lambda b: -(b["mtime"] or 0))
        return {"blocks": blocks, "pending": sum(not b["replied"] for b in blocks)}

    def _blocks(self, rel: str, lines: list[str], mtime: int | None) -> list[dict]:
        out = []
        i = 0
        while i < len(lines):
            m = self.ANNOT_HEAD.match(lines[i])
            if not m:
                i += 1
                continue
            start = i
            j = i + 1
            while j < len(lines) and lines[j].startswith(">"):
                j += 1
            body = [ln[1:].strip() for ln in lines[start + 1:j]]
            heading = ""
            for k in range(start - 1, -1, -1):
                if lines[k].startswith("#"):
                    heading = lines[k].lstrip("#").strip()
                    break
            text = "\n".join(body).strip()
            out.append({"id": f"{rel}:{start + 1}", "path": rel, "line": start + 1, "end_line": j,
                        "end_raw": lines[j - 1], "meta": m.group(1).strip(), "heading": heading,
                        "text": text, "replied": "→ the user:" in text, "mtime": mtime})
            i = j
        return out

    def reply_annotation(self, rel: str, end_line: int, end_raw: str, text: str) -> None:
        self.append_quote(rel, end_line, end_raw, text, prefix="→ the user: ")

    # ------------------------------------------------------------ Writing

    @property
    def PAPERS(self) -> dict[str, dict]:  # noqa: N802 — from projects.yaml: paper folder + key docs
        return {p.name: {"dir": self.projects.paper_dir(p.name), "docs": list(p.docs)} for p in self.projects.all()}

    TEX_CMD = re.compile(r"\\[a-zA-Z@]+\*?(\[[^\]]*\])?")

    def writing(self) -> dict:
        papers = []
        for name, cfg in self.PAPERS.items():
            d = self.root / cfg["dir"]
            tex_dir = d / "texfiles"
            sections = []
            if tex_dir.is_dir():
                for f in sorted(tex_dir.glob("*.tex")):
                    sections.append(self._section(f, f"{cfg['dir']}/texfiles/{f.name}"))
            url = None
            cfgfile = _read(d / ".git" / "config") or ""
            m = re.search(r"git\.overleaf\.com/([0-9a-f]{16,})", cfgfile)
            if m:
                url = f"https://www.overleaf.com/project/{m.group(1)}"
            docs = [{"path": p, "mtime": _mtime(self.root / p)} for p in cfg["docs"] if (self.root / p).is_file()]
            papers.append({"name": name, "overleaf": url, "sections": sections, "docs": docs,
                           "words": sum(s["words"] for s in sections),
                           "pdf": f"{cfg['dir']}/main.pdf" if (d / "main.pdf").is_file() else None})
        return {"papers": papers}

    def _section(self, f: Path, rel: str) -> dict:
        text = _read(f) or ""
        body = "\n".join(ln.split("%", 1)[0] if not ln.lstrip().startswith("%") else "" for ln in text.split("\n"))
        todos = len(re.findall(r"\\todo|TODO|XXX", text))
        plain = self.TEX_CMD.sub(" ", body)
        plain = re.sub(r"[{}$\\&~^_]", " ", plain)
        cjk = len(re.findall(r"[\u4e00-\u9fff]", plain))
        words = len(re.findall(r"[A-Za-z][A-Za-z'\-]*", plain)) + cjk // 2
        status = "empty" if words < 30 else "stub" if words < 300 else "draft" if todos else "written"
        return {"name": f.name, "path": rel, "words": words, "todos": todos, "status": status, "mtime": _mtime(f)}

    # ------------------------------------------------------------ Weekly / time

    def weekly(self, week_start: str | None = None) -> dict:
        today = today_local()
        start = date.fromisoformat(week_start) if week_start else today - timedelta(days=today.weekday())
        start = start - timedelta(days=start.weekday())
        end = start + timedelta(days=6)
        rows = []
        for line in (_read(self.root / "time_log.jsonl") or "").splitlines():
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get("type") == "daily_summary" or "ts" not in r:
                continue
            try:
                ts = datetime.fromisoformat(str(r["ts"]).replace("Z", "+00:00"))
                d = (ts.astimezone(TZ) if ts.tzinfo else ts).date()
            except ValueError:
                continue
            if start <= d <= end:
                rows.append({"date": d.isoformat(), "project": r.get("project", "other"),
                             "task": r.get("task", ""), "minutes": float(r.get("duration_min") or 0)})
        by_project: dict[str, float] = defaultdict(float)
        by_day: dict[str, float] = defaultdict(float)
        for r in rows:
            by_project[r["project"]] += r["minutes"]
            by_day[r["date"]] += r["minutes"]
        reports_dir = self.root / "weekly_reports"
        reports = sorted((f.name for f in reports_dir.glob("*.md")), reverse=True)[:30] if reports_dir.is_dir() else []
        return {"week_start": start.isoformat(), "week_end": end.isoformat(), "today": today.isoformat(),
                "entries": sorted(rows, key=lambda r: r["date"]),
                "by_project": sorted(({"project": k, "minutes": v} for k, v in by_project.items()),
                                     key=lambda x: -x["minutes"]),
                "by_day": [{"date": (start + timedelta(days=i)).isoformat(),
                            "minutes": by_day.get((start + timedelta(days=i)).isoformat(), 0)} for i in range(7)],
                "total_minutes": sum(by_project.values()),
                "habits": self.habit_rates(start, end),
                "reports": [{"name": n, "path": f"weekly_reports/{n}"} for n in reports]}


def stamp() -> int:
    return int(time.time() * 1000)
