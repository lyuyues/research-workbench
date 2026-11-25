import asyncio
from datetime import date
from pathlib import Path
import json
import os
import re
import shutil
import threading
import time
from typing import Literal

from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .access import CF_HEADER, make_verifier, origin_allowed
from .agent import IMAGE_MAX, AgentRun, build_prompt, save_images
from . import audiobook, bookshelf, paper_audio
from .automation import Automation
from .badges import Badges
from .brain import AINotConfigured, Brain, BrainError, NotFound as BrainNotFound
from .brain_import import ImportBusy, importer_for
from .paper_pdf import PaperPdf
from .overleaf import Overleaf, OverleafConflict, OverleafError, sha as overleaf_sha
from .oplog import OpLog
from .journal import Journal, JournalUnavailable, UndoConflict, UndoRejected
from .panels import PANELS
from .roles import OWNER_LOCAL, AccessList, User, strip_tex_comments, viewer_may, viewer_writing
from .settings import Settings
from .story import Story
from .projects import Projects
from .meetings import MeetingConflict, Meetings
from .timeline import Timeline, calendar_group
from .trends import Trends
from .literature_cfg import LiteratureConfig
from .reading import COLORS, STATUSES, NotesConflict, Reading
from .zotero import ZoteroAPI, ZoteroError, ZoteroSync, load_config
from .workspace import EditConflict, Workspace, section_kind

class CheckboxEdit(BaseModel):
    path: str
    line: int = Field(ge=1)
    expect: str
    checked: bool


class OverleafSave(BaseModel):
    path: str
    sha: str
    text: str = Field(max_length=2_000_000)


class ReportCommentNew(BaseModel):
    report: str
    quote: str = Field(min_length=1, max_length=2000)
    prefix: str = Field(default="", max_length=200)
    suffix: str = Field(default="", max_length=200)
    text: str = Field(min_length=1, max_length=5000)


class ReportCommentUpdate(BaseModel):
    report: str
    id: str
    text: str | None = Field(default=None, max_length=5000)
    resolved: bool | None = None
    delete: bool = False
    reply: str | None = Field(default=None, max_length=5000)


class PaperPublish(BaseModel):
    digest: str
    message: str = Field(default="", max_length=300)


class MessageReplace(BaseModel):
    line: int = Field(ge=1)       # the notes-for-Claude section header line
    end_line: int = Field(ge=1)   # its last line
    end_raw: str
    text: str = Field(max_length=20000)


class QuoteEdit(BaseModel):
    path: str
    line: int = Field(ge=1)       # annotation: the ⚠️ header line; message: the section header line
    end_line: int = Field(ge=1)   # insert after this line
    end_raw: str                  # its current content (conflict check)
    text: str = Field(min_length=1, max_length=20000)


CHECKBOX_FILES = ("daily_tracker.md", "research_tasks.md", "meetings/questions.md", "timeline.md")


def checkbox_allowed(path: str) -> bool:
    return path in CHECKBOX_FILES or (path.startswith("literature-radar/digests/") and path.endswith(".md")
                                      and path.count("/") == 2)


class MeetingQuestion(BaseModel):
    kind: Literal["advisor", "group"]
    text: str = Field(min_length=1, max_length=2000)


class MeetingNotes(BaseModel):
    kind: Literal["advisor", "group"]
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    text: str = Field(min_length=1, max_length=200_000)
    expect: str = Field(default="", max_length=400_000)
    which: Literal["notes", "slides", "slack", "recap"] = "notes"


class TodayTask(BaseModel):
    text: str


class TodayRemove(BaseModel):
    line: int
    expect: str


class BadgeSeen(BaseModel):
    panel: str


class MeetingPush(BaseModel):
    kind: str
    date: str


class TrendsConfig(BaseModel):
    config: dict


class StorySave(BaseModel):
    version: int
    items: list
    title: str | None = None


class TrendSave(BaseModel):
    item: dict
    saved: bool
    day: str | None = Field(default=None, max_length=10)


class LiteratureSettings(BaseModel):
    config: dict


class PaperAdd(BaseModel):
    model_config = ConfigDict(extra="ignore")
    title: str = Field(min_length=1, max_length=400)
    authors: list[str] | str | None = None
    year: str | int | None = None
    venue: str | None = None
    doi: str | None = None
    arxiv: str | None = None
    url: str | None = None
    pdf_url: str | None = None
    zotero_key: str | None = None
    zotero_attachment: str | None = None
    source: str = "manual"
    zotero: bool = False


class PositionIn(BaseModel):
    page: int = Field(ge=0, le=20000)  # 0-based page index (Zotero's lastPageIndex)


class PaperUpdate(BaseModel):
    status: Literal[STATUSES] | None = None  # type: ignore[valid-type]
    zotero: bool | None = None
    pdf_url: str | None = Field(default=None, max_length=1000)
    tags: list[str] | None = Field(default=None, max_length=30)
    rating: int | None = Field(default=None, ge=0, le=5)  # 0 = no rating


class HighlightIn(BaseModel):
    page: int = Field(ge=0, le=5000)
    rects: list[list[float]] = Field(min_length=1, max_length=300)
    top: float | None = None
    page_height: float | None = None
    text: str = Field(default="", max_length=5000)
    comment: str = Field(default="", max_length=5000)
    color: str = "yellow"


class HighlightEdit(BaseModel):
    comment: str | None = Field(default=None, max_length=5000)
    color: str | None = None
    delete: bool = False


class PaperNotes(BaseModel):
    text: str = Field(min_length=1, max_length=500_000)
    expect: str = Field(default="", max_length=1_000_000)


class UndoRequest(BaseModel):
    commit: str


class PromptContext(BaseModel):
    model_config = ConfigDict(extra="ignore")
    panel: str | None = None
    card: str | None = None


class PromptMsg(BaseModel):
    type: Literal["prompt"] = "prompt"
    prompt: str = Field(min_length=1)
    context: PromptContext | None = None
    images: list[str] = Field(default_factory=list, max_length=IMAGE_MAX)  # data URLs pasted into the chat
    # passed as `--resume <id>`: must never look like a flag
    session_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")


class CancelMsg(BaseModel):
    type: Literal["cancel"]


def parse_message(raw: str) -> PromptMsg | CancelMsg:
    """Raises ValueError (incl. pydantic ValidationError) for anything malformed."""
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("message must be a JSON object")
    if data.get("type") == "cancel":
        return CancelMsg.model_validate(data)
    return PromptMsg.model_validate(data)


def create_app(settings: Settings) -> FastAPI:
    app = FastAPI(title="Research Platform")
    verifier = make_verifier(settings)  # None when access is off; raises if misconfigured
    journal = Journal(settings.git_dir, settings.research_root)
    journal.prepare()
    oplog = OpLog(settings.oplog_path or settings.git_dir.parent / "oplog.jsonl")
    app.state.oplog = oplog
    oplog.append("system", "service started")
    # The first baseline of the real tree takes minutes; do it off the startup path and
    # refuse agent runs / undo until it has finished.
    journal_ready = threading.Event()
    app.state.journal_ready = journal_ready
    app.state.journal_error = None
    if journal.has_baseline():
        journal_ready.set()
    else:
        def _baseline() -> None:
            try:
                journal.ensure_baseline()
                journal_ready.set()
            except Exception as exc:  # stays not-ready; restart the service to retry
                app.state.journal_error = str(exc)[-300:]

        threading.Thread(target=_baseline, name="journal-baseline", daemon=True).start()

    def journal_status() -> str | None:
        if journal_ready.is_set():
            return None
        if app.state.journal_error:
            return f"journal initialization failed: {app.state.journal_error}"
        return "journal initializing, try again shortly"
    # One agent run at a time: keeps git snapshots unambiguous. The lock is per-process,
    # so the service must run a single uvicorn worker (`--workers 1`, see deploy unit).
    lock = asyncio.Lock()
    runs: set[asyncio.Task] = set()  # strong refs so detached runs aren't GC'd
    # App-scoped so any authenticated socket can cancel a run whose socket has gone away.
    current: dict = {"run": None}

    # Owner = RP_ACCESS_EMAIL (everything); viewers from the access file (read-only, some panels).
    acl = AccessList(settings.access_file if verifier else None)
    app.state.acl = acl
    seen: set[tuple] = set()  # (email, what, day) already written to the System log

    def audit(user: User, action: str, detail: str) -> None:
        key = (user.email, action, detail, time.strftime("%Y-%m-%d"))
        if key not in seen:
            seen.add(key)
            oplog.append("viewer", action, f"{user.email}: {detail}")

    @app.middleware("http")
    async def access_guard(request: Request, call_next):
        path = request.url.path
        user = OWNER_LOCAL
        if path.startswith("/podcast/"):
            # Podcast apps can't log in: these routes check a secret token in the path instead
            # (Cloudflare Access has a bypass policy for /podcast/ only).
            return await call_next(request)
        if verifier and path != "/api/health":
            email = await asyncio.to_thread(verifier.identify, request.headers.get(CF_HEADER))
            user = acl.user(email, settings.access_email)
            if user is None:
                return JSONResponse({"detail": "forbidden"}, status_code=403)
            if not user.owner:
                if not viewer_may(user, request.method, path):
                    return JSONResponse({"detail": "not available to viewers"}, status_code=403)
                if path == "/api/panels":
                    audit(user, "opened the platform", ", ".join(sorted(user.panels)))
        request.state.user = user
        return await call_next(request)

    def who(request: Request) -> User:
        return getattr(request.state, "user", OWNER_LOCAL)

    @app.get("/api/health")
    def health() -> dict:
        return {"ok": True}

    automation = Automation(settings.research_root, settings.state_dir or oplog.path.parent)

    @app.get("/api/automation")
    async def get_automation() -> dict:
        return await asyncio.to_thread(automation.snapshot)

    @app.post("/api/automation/run/{name}")
    def run_job(name: str) -> dict:
        try:
            automation.request_run(name)
        except KeyError:
            raise HTTPException(404, "unknown job")
        oplog.append("user", "run now requested", name)
        return {"requested": name}

    @app.get("/api/oplog")
    def get_oplog(limit: int = 300) -> list[dict]:
        return oplog.read(max(1, min(limit, 2000)))

    @app.get("/api/panels")
    def panels(request: Request) -> list[dict]:
        user = who(request)
        return [p for p in PANELS if user.can(p["id"])]

    @app.get("/api/me")
    def me(request: Request) -> dict:
        user = who(request)
        return {"email": user.email, "role": user.role, "panels": sorted(user.panels) if not user.owner else None}

    projects = Projects(settings.research_root)
    ws_ = Workspace(settings.research_root, projects)

    @app.get("/api/project-list")
    async def project_list() -> dict:
        """The projects in projects.yaml (story canvas tabs, paper drafts, meeting sections)."""
        try:
            return {"projects": [p.public() for p in await asyncio.to_thread(projects.all)], "error": None}
        except ValueError as exc:
            return {"projects": [], "error": str(exc)}

    overleaf = Overleaf(settings.research_root, settings.state_dir or oplog.path.parent, projects=projects)
    paper_pdf = PaperPdf(settings.research_root, settings.state_dir or oplog.path.parent, projects=projects)

    async def view(fn, *args):
        try:
            return await asyncio.to_thread(fn, *args)
        except ValueError as exc:
            raise HTTPException(400, str(exc))

    @app.get("/api/daily")
    async def get_daily() -> dict:
        return await view(ws_.daily)

    @app.get("/api/tasks")
    async def get_tasks() -> dict:
        data = await view(ws_.tasks)
        data["log"] = await view(ws_.progress_log)
        return data

    @app.get("/api/project-links")
    async def get_project_links() -> dict:
        return await view(ws_.project_links)

    @app.get("/api/portfolio")
    async def get_portfolio() -> dict:
        return await view(ws_.portfolio)

    @app.get("/api/literature")
    async def get_literature(digest: str | None = None) -> dict:
        return await view(ws_.literature, digest)

    lit_cfg = LiteratureConfig(settings.research_root)

    @app.get("/api/literature/config")
    async def get_literature_config() -> dict:
        return await view(lit_cfg.view)

    @app.post("/api/literature/config")
    async def save_literature_config(req: LiteratureSettings) -> dict:
        out = await edit(lit_cfg.save, req.config)
        oplog.append("user", "literature radar settings saved",
                     f"{len(out['keyword_groups'])} keyword groups, {len(out['tracked_authors'])} authors, "
                     f"{len(out['venues']['tier1'])}+{len(out['venues']['tier2'])} venues, look-back {out['lookback_days']} d")
        schedule_snapshot("web: literature radar settings")
        return out

    @app.get("/api/annotations")
    async def get_annotations() -> dict:
        return await view(ws_.annotations)

    @app.get("/api/writing")
    async def get_writing(request: Request) -> dict:
        data = await view(ws_.writing)
        return data if who(request).owner else viewer_writing(data)

    story = Story(settings.research_root, projects)

    @app.get("/api/story/{project}")
    async def get_story(project: str) -> dict:
        return await view(story.load, project)

    @app.post("/api/story/{project}/image")
    async def story_image(project: str, request: Request) -> dict:
        data = await request.body()
        try:
            name = await asyncio.to_thread(story.add_image, project, data)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return {"src": name}

    @app.get("/api/story/{project}/image/{name}")
    async def story_image_get(project: str, name: str):
        try:
            hit = story.image_path(project, name)
        except ValueError:
            hit = None
        if hit is None:
            raise HTTPException(404, "no such image")
        return FileResponse(hit[0], media_type=hit[1], headers={"Cache-Control": "private, max-age=31536000, immutable"})

    @app.post("/api/story/{project}")
    async def save_story(project: str, req: StorySave) -> dict:
        out = await edit(story.save, project, req.version, req.items, req.title)
        schedule_snapshot(f"web: story canvas {project}")
        return out

    trends = Trends(settings.research_root)

    @app.get("/api/trends")
    async def get_trends(day: str | None = None) -> dict:
        return await view(trends.view, day)

    @app.post("/api/trends/config")
    async def save_trends_config(req: TrendsConfig) -> dict:
        out = await edit(trends.save_config, req.config)
        oplog.append("user", "trends config saved",
                     f"{len(out['topics'])} topics ({', '.join(t['name'] for t in out['topics'])}), "
                     f"{sum(s['enabled'] for s in out['sources'])} sources")
        schedule_snapshot("web: trends config")
        return out

    @app.post("/api/trends/saved")
    async def save_trend(req: TrendSave) -> dict:
        return {"saved": await edit(trends.set_saved, req.item, req.saved, req.day)}

    timeline = Timeline(settings.research_root)

    @app.get("/api/timeline")
    async def get_timeline() -> dict:
        out = await view(timeline.view)
        out["google"] = None  # no calendar in the public edition
        return out

    meetings = Meetings(settings.research_root, projects)

    @app.get("/api/meetings")
    async def get_meetings() -> dict:
        return await view(meetings.view)

    @app.post("/api/meetings/question")
    async def add_question(req: MeetingQuestion) -> dict:
        await edit(meetings.add_question, req.kind, req.text)
        oplog.append("user", "meeting question added", f"{req.kind}: {req.text[:200]}")
        schedule_snapshot(f"web: {req.kind} meeting question")
        return {"ok": True}

    @app.post("/api/meetings/notes")
    async def save_notes(req: MeetingNotes) -> dict:
        try:
            rel = await edit(meetings.save_notes, req.kind, req.date, req.text, req.expect, req.which)
        except MeetingConflict as exc:
            raise HTTPException(409, str(exc))
        oplog.append("user", f"meeting {req.which} saved", rel)
        added = 0
        if req.which == "recap":  # reviewed recap → its todos become MEET tasks in research_tasks.md
            added = await edit(meetings.todos_to_tasks, req.kind, req.date)
            if added:
                oplog.append("user", "meeting todos → tasks", f"{req.kind} {req.date}: {added} added to research_tasks.md")
        schedule_snapshot(f"web: {req.kind} meeting {req.which} {req.date}")
        return {"path": rel, "tasks_added": added}

    reading = Reading(settings.research_root)
    zsync: dict = {"pending": set(), "event": None, "last": {}}

    def zotero() -> ZoteroSync | None:
        cfg = load_config(settings.zotero_file)
        return ZoteroSync(reading, ZoteroAPI(cfg["user_id"], cfg["api_key"])) if cfg else None

    def background(fn, *args) -> None:
        async def _run() -> None:
            try:
                await asyncio.to_thread(fn, *args)
            except Exception as exc:
                oplog.append("system", "reading task failed", f"{getattr(fn, '__name__', fn)}: {exc}"[:300])
        task = asyncio.create_task(_run())
        runs.add(task)
        task.add_done_callback(runs.discard)

    def zotero_soon(pid: str) -> None:
        zsync["pending"].add(pid)
        if zsync["event"] is not None:
            zsync["event"].set()

    def zotero_sync_one(z: ZoteroSync, pid: str) -> None:
        try:
            out = z.sync_paper(pid)
        except (ZoteroError, KeyError) as exc:
            msg = str(exc)[:300]
            if zsync["last"].get(pid) != msg:
                oplog.append("system", "zotero sync failed", f"{pid}: {msg}")
            zsync["last"][pid] = msg
            return
        zsync["last"].pop(pid, None)
        did = [f"note {out['note']}" if out["note"] in ("created", "updated") else "",
               f"{out['pushed']} highlight(s) added" if out["pushed"] else "",
               f"{out['updated']} updated" if out["updated"] else "", f"{out['deleted']} deleted" if out["deleted"] else ""]
        if any(did):
            oplog.append("system", "zotero sync", f"{pid}: " + ", ".join(d for d in did if d))

    async def zotero_loop() -> None:
        """Every 10 min: all Zotero-linked papers; a change syncs its paper ~20 s later (debounced)."""
        zsync["event"] = asyncio.Event()
        full_at = 0.0
        while True:
            try:
                await asyncio.wait_for(zsync["event"].wait(), timeout=600)
                await asyncio.sleep(20)
            except asyncio.TimeoutError:
                pass
            zsync["event"].clear()
            z = zotero()
            if z is None:
                zsync["pending"].clear()
                continue
            try:
                await asyncio.to_thread(z.ensure_collection)
            except ZoteroError as exc:
                oplog.append("system", "zotero sync failed", str(exc)[:300])
                continue
            ids = set(zsync["pending"])
            zsync["pending"].clear()
            if time.monotonic() - full_at > 590:
                full_at = time.monotonic()
                ids |= {x["id"] for x in (await asyncio.to_thread(reading.view))["papers"]
                        if x["zotero"]["key"] and x.get("status") != "dropped"}
            for pid in sorted(ids):
                await asyncio.to_thread(zotero_sync_one, z, pid)

    @app.on_event("startup")
    async def _start_zotero() -> None:
        if settings.zotero_file is not None:
            task = asyncio.create_task(zotero_loop())
            runs.add(task)

    def paper_or_404(pid: str) -> dict:
        try:
            return reading.paper(pid)
        except (KeyError, ValueError):
            raise HTTPException(404, "no such paper")

    @app.get("/api/reading")
    async def get_reading() -> dict:
        out = await view(reading.view)
        out["zotero_configured"] = load_config(settings.zotero_file) is not None
        out["colors"] = COLORS
        return out

    @app.get("/api/reading/zotero-search")
    async def zotero_search(q: str) -> dict:
        return {"items": await asyncio.to_thread(reading.zotero_search, q[:200])}

    @app.post("/api/reading/add")
    async def add_paper(req: PaperAdd) -> dict:
        meta = req.model_dump()
        zot = meta.pop("zotero")
        if req.zotero_key and (it := await asyncio.to_thread(reading.zotero_item, req.zotero_key)):
            meta.setdefault("zotero_attachment", it.get("pdf_key"))
            meta["zotero_attachment"] = meta.get("zotero_attachment") or it.get("pdf_key")
        try:
            x, new = await asyncio.to_thread(reading.add, meta, zotero=zot)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        if new:
            oplog.append("user", "paper added to reading list", f"{x['title'][:150]} ({x['source']})")
            background(reading.download_pdf, x["id"])
        if x.get("zotero_key"):
            zotero_soon(x["id"])
        return {"id": x["id"], "new": new}

    # Scanned PDFs (no text layer) get an invisible OCR text layer so they can be highlighted / quoted.
    # backend/pdf_ocr.py needs pymupdf + RapidOCR, which live in the audiobooks venv, so it runs there.
    OCR_PY = Path.home() / "audiobooks/.venv/bin/python"

    def ocr_status(pdf: Path) -> dict | None:
        try:
            return json.loads(pdf.with_name(pdf.stem + ".ocr.json").read_text())
        except (OSError, ValueError):
            return None

    def ocr_start(pdf: Path, force: bool = False) -> bool:
        """Start OCR in the background unless it ran already (the script itself skips PDFs that have text)."""
        st = ocr_status(pdf)
        stale = st and st.get("state") == "running" and time.time() * 1000 - st.get("updated", 0) > 600_000
        if not OCR_PY.exists() or not pdf.is_file() or (st and not force and not stale):
            return False
        import subprocess
        pdf.with_name(pdf.stem + ".ocr.json").write_text(json.dumps({"state": "running", "done": 0, "total": 0,
                                                                     "updated": int(time.time() * 1000)}))
        subprocess.Popen(["nice", "-n", "10", str(OCR_PY), "-W", "ignore", str(Path(__file__).with_name("pdf_ocr.py")),
                          str(pdf)] + (["--force"] if force else []),
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, start_new_session=True)
        return True

    @app.post("/api/reading/paper/{pid}/ocr")
    def paper_ocr(pid: str) -> dict:
        """Re-run OCR on demand (e.g. a PDF with a broken text layer)."""
        x = paper_or_404(pid)
        if not ocr_start(reading.p(x["pdf"]), force=True):
            raise HTTPException(409, "OCR is not available or already running")
        oplog.append("user", "pdf ocr started", x["title"][:150])
        return {"ok": True}

    @app.get("/api/reading/paper/{pid}")
    async def get_paper(pid: str) -> dict:
        x = paper_or_404(pid)
        pdf = reading.p(x["pdf"])
        if pdf.is_file() and ocr_status(pdf) is None:
            ocr_start(pdf)  # first open: check for a text layer, OCR if there is none
        ocr = ocr_status(pdf) if pdf.is_file() else None
        papers = (await asyncio.to_thread(reading.view))["papers"]
        d = next(p for p in papers if p["id"] == pid)
        ann = await asyncio.to_thread(reading.annotations, pid)
        z = ((reading.server_state().get("papers") or {}).get(pid) or {}).get("annotations") or []
        if not x.get("opened") or time.time() * 1000 - x["opened"] > 3_600_000:
            await asyncio.to_thread(reading.update, pid, opened=int(time.time() * 1000))
        return {"paper": d, "highlights": ann["highlights"], "zotero_highlights": z,
                "notes": await asyncio.to_thread(reading.notes, pid), "colors": COLORS, "ocr": ocr}

    badges = Badges(settings.research_root, settings.state_dir or oplog.path.parent)

    @app.get("/api/badges")  # owner only: things waiting for the user (sidebar dots)
    async def get_badges() -> dict:
        def run() -> dict:
            try:
                pending = ws_.annotations().get("pending", 0)
            except Exception:  # noqa: BLE001 — a badge must never break the page
                pending = 0
            return badges.compute(pending, [], 0, {})
        return await asyncio.to_thread(run)

    @app.post("/api/badges/seen")
    async def badges_seen(req: BadgeSeen) -> dict:
        try:
            badges.mark_seen(req.panel)
        except ValueError:
            return {"ok": False}
        return {"ok": True}

    # ------------------------------------------------------------ background music (owner only:
    # /api/music is not in roles.VIEWER_API, so viewers get 403 before reaching here)
    MUSIC_TYPES = {".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg",
                   ".opus": "audio/ogg", ".flac": "audio/flac", ".wav": "audio/wav"}

    def music_files() -> list[Path]:
        d = settings.music_dir
        if d is None or not d.is_dir():
            return []
        return sorted((f for f in d.iterdir() if f.is_file() and f.suffix.lower() in MUSIC_TYPES
                       and not f.name.startswith(".")), key=lambda f: f.name.lower())

    @app.get("/api/music")
    def music_list():
        return [{"name": f.stem, "file": f.name, "size": f.stat().st_size} for f in music_files()]

    @app.get("/api/music/file")
    def music_file(name: str):
        for f in music_files():
            if f.name == name:  # only names from the listing: no paths
                return FileResponse(f, media_type=MUSIC_TYPES[f.suffix.lower()],
                                    headers={"Cache-Control": "private, max-age=86400"})
        raise HTTPException(404, "not found")

    # ------------------------------------------------------------ audiobook podcast (token in path;
    # no Access login, see access_guard). Books are made on the server by backend/audiobook.py.
    def podcast_guard(token: str) -> tuple[Path, str]:
        """The token picks the feed (books = private reading, research = shareable)."""
        feed = audiobook.feed_for_token(settings.podcast_token_file, token) if settings.podcast_token_file else None
        if feed is None or settings.audiobook_root is None:
            raise HTTPException(404, "not found")
        return settings.audiobook_root, feed

    @app.api_route("/podcast/{token}/feed.xml", methods=["GET", "HEAD"])
    def podcast_feed(token: str, request: Request):
        root, feed = podcast_guard(token)
        base = f"https://{request.headers.get('host', 'research.example.com')}/podcast/{token}"
        xml = audiobook.feed_xml(audiobook.load_books(root), base, feed)
        return Response(xml, media_type="application/rss+xml; charset=utf-8",
                        headers={"Cache-Control": "no-store"})

    @app.api_route("/podcast/{token}/book/{slug}.xml", methods=["GET", "HEAD"])
    def podcast_book_feed(token: str, slug: str, request: Request):
        """One book as its own podcast (the Audiobooks panel copies these links)."""
        root, feed = podcast_guard(token)
        if audiobook.book_feed(root, slug) != feed:
            raise HTTPException(404, "not found")
        base = f"https://{request.headers.get('host', 'research.example.com')}/podcast/{token}"
        xml = audiobook.feed_xml(audiobook.load_books(root), base, feed, slug)
        return Response(xml, media_type="application/rss+xml; charset=utf-8",
                        headers={"Cache-Control": "no-store"})

    class AudiobookProgress(BaseModel):
        slug: str = Field(max_length=200)
        file: str = Field(max_length=20)
        pos: float = Field(ge=0, le=86400)

    @app.get("/api/audiobooks/progress")
    def audiobook_progress():
        return audiobook.load_progress(settings.audiobook_root) if settings.audiobook_root else {}

    @app.post("/api/audiobooks/progress")
    def set_audiobook_progress(body: AudiobookProgress):
        if settings.audiobook_root is None:
            raise HTTPException(503, "audiobooks not configured")
        try:
            audiobook.save_progress(settings.audiobook_root, body.slug, body.file, body.pos)
        except ValueError:
            raise HTTPException(404, "unknown episode")
        return {"ok": True}

    @app.get("/api/audiobooks/file/{slug}/{name}")  # in-site player (owner, behind Access login)
    def audiobook_file(slug: str, name: str):
        f = audiobook.chapter_file(settings.audiobook_root, slug, name) if settings.audiobook_root else None
        if f is None:
            raise HTTPException(404, "not found")
        return FileResponse(f, media_type="audio/mpeg", headers={"Cache-Control": "private, max-age=86400"})

    # ------------------------------------------------------------ bookshelf: the user's Zotero books (owner only)
    @app.get("/api/bookshelf")
    def bookshelf_list():
        root = settings.audiobook_root
        if root is None:
            raise HTTPException(503, "audiobooks not configured")
        data = bookshelf.load(root)
        made = {b["zotero_key"]: b["slug"] for b in audiobook.load_books(root) if b.get("zotero_key")}
        waiting = {q["zotero_key"] for q in audiobook.queued(root) if q.get("zotero_key")}
        reqs = bookshelf.requests(root)
        live = audiobook.load_status(root)
        for b in data["books"]:
            k = b["key"]
            b["progress"] = ({x: live.get(x) for x in ("stage", "done", "total")}
                             if k in waiting and live.get("zotero_key") == k else None)
            b["audiobook"] = made.get(k)
            b["status"] = ("converting" if k in waiting else
                           "error" if reqs.get(k, {}).get("error") else
                           "requested" if k in reqs else None)
            b["error"] = reqs.get(k, {}).get("error")
            b["readable"] = bookshelf.book_file(root, k) is not None
        return data

    @app.post("/api/bookshelf/{key}/read")
    async def bookshelf_read(key: str) -> dict:
        """Open a book in the Reading reader (same as a paper: highlights, notes, agent, Zotero sync).
        The book becomes a reading-list item tagged "book", linked to its Zotero item and attachment;
        its PDF comes from the server copy right away (otherwise the Mac bridge copies it from Zotero)."""
        root = settings.audiobook_root
        book = next((b for b in bookshelf.load(root)["books"] if b["key"] == key), None) if root else None
        if book is None:
            raise HTTPException(404, "not in your Zotero books")
        att = book.get("attachment") or {}
        if att.get("format") != "pdf":
            raise HTTPException(400, "only PDF books open in the reader (this one is an EPUB)")
        meta = {"title": book["title"], "authors": book.get("authors") or [], "year": book.get("year") or "",
                "venue": book.get("publisher") or "", "zotero_key": key, "zotero_attachment": att.get("key"), "source": "zotero"}
        try:
            x, new = await asyncio.to_thread(reading.add, meta)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        if "book" not in (x.get("tags") or []):
            await asyncio.to_thread(reading.update, x["id"], tags=[*(x.get("tags") or []), "book"])
        dest = reading.p(x["pdf"])
        if not dest.is_file() and (f := bookshelf.book_file(root, key)) is not None and f.suffix == ".pdf":
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_suffix(".tmp")
            await asyncio.to_thread(shutil.copyfile, f, tmp)
            os.replace(tmp, dest)
        if new:
            oplog.append("user", "book opened in reader", book["title"][:150])
        zotero_soon(x["id"])
        return {"id": x["id"], "new": new}

    @app.get("/api/bookshelf/{key}/file")
    def bookshelf_file(key: str):
        root = settings.audiobook_root
        f = bookshelf.book_file(root, key) if root else None
        if f is None:
            raise HTTPException(404, "this book's file is not on the server (only books opened in the last 30 days are)")
        return FileResponse(f, media_type=bookshelf.FORMATS[f.suffix[1:]],
                            content_disposition_type="inline" if f.suffix == ".pdf" else "attachment",
                            filename=f.name, headers={"Cache-Control": "private, max-age=600"})

    @app.post("/api/bookshelf/{key}/audiobook")
    def bookshelf_make_audiobook(key: str):
        root = settings.audiobook_root
        if root is None:
            raise HTTPException(503, "audiobooks not configured")
        book = next((b for b in bookshelf.load(root)["books"] if b["key"] == key), None)
        if book is None:
            raise HTTPException(404, "not in your Zotero books")
        if not book.get("attachment"):
            raise HTTPException(400, "this book has no PDF/EPUB in Zotero")
        bookshelf.request(root, key)
        oplog.append("user", "audiobook requested", book["title"])
        return {"status": "requested"}

    @app.get("/api/audiobooks")  # owner only (not in roles.VIEWER_API): has the secret feed URLs
    def audiobooks_overview():
        if settings.audiobook_root is None or settings.podcast_token_file is None:
            return {"feeds": {}, "books": []}
        return audiobook.overview(settings.audiobook_root, settings.podcast_token_file,
                                  settings.allowed_origin.rstrip("/"))

    @app.api_route("/podcast/{token}/{slug}/{name}", methods=["GET", "HEAD"])
    def podcast_episode(token: str, slug: str, name: str):
        root, feed = podcast_guard(token)
        f = audiobook.chapter_file(root, slug, name)
        if f is None or audiobook.book_feed(root, slug) != feed:  # a token only opens its own feed
            raise HTTPException(404, "not found")
        return FileResponse(f, media_type="audio/mpeg", headers={"Cache-Control": "private, max-age=86400"})

    # ------------------------------------------------------------ paper audio brief (🎧, on demand)
    def audio_root() -> Path:
        if settings.audiobook_root is None:
            raise HTTPException(503, "audio is not configured")
        return settings.audiobook_root

    @app.get("/api/reading/paper/{pid}/audio")
    def paper_audio_status(pid: str) -> dict:
        paper_or_404(pid)
        return paper_audio.status(audio_root(), pid)

    @app.post("/api/reading/paper/{pid}/audio")
    def paper_audio_make(pid: str) -> dict:
        x = paper_or_404(pid)
        root = audio_root()
        if not paper_audio.running(root, pid):
            pdf = reading.p(x["pdf"])
            if not pdf.is_file():
                raise HTTPException(400, "the PDF is not available yet")
            paper_audio.start(root, pid, pdf, x["title"], python=settings.audiobook_python,
                              claude_bin=settings.claude_bin)
            oplog.append("user", "paper audio brief started", x["title"][:150])
        return paper_audio.status(root, pid)

    @app.get("/api/reading/paper/{pid}/audio.mp3")
    def paper_audio_file(pid: str):
        paper_or_404(pid)
        root = audio_root()
        ep = paper_audio.episode(root, pid)
        if ep is None:
            raise HTTPException(404, "no audio yet")
        return FileResponse(paper_audio.book_dir(root) / ep["file"], media_type="audio/mpeg",
                            headers={"Cache-Control": "private, max-age=600"})

    @app.get("/api/reading/paper/{pid}/pdf")
    def get_pdf(pid: str):
        x = paper_or_404(pid)
        p = reading.p(x["pdf"])
        if not p.is_file():
            raise HTTPException(404, "PDF not available yet")
        return FileResponse(p, media_type="application/pdf", headers={"Cache-Control": "private, max-age=600"})

    @app.post("/api/reading/paper/{pid}")
    async def update_paper(pid: str, req: PaperUpdate) -> dict:
        x = paper_or_404(pid)
        fields: dict = {}
        if req.status:
            fields["status"] = req.status
        if req.zotero is not None:
            fields["zotero_want"] = req.zotero
        if req.pdf_url is not None:
            if not re.match(r"^https?://\S+$", req.pdf_url):
                raise HTTPException(400, "the PDF link must be an http(s) URL")
            fields.update(pdf_url=req.pdf_url, pdf_error=None)
        if req.tags is not None:
            fields["tags"] = req.tags
        if req.rating is not None:
            fields["rating"] = req.rating
        try:
            await asyncio.to_thread(reading.update, pid, **fields)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        if req.pdf_url is not None:
            background(reading.download_pdf, pid)
        if fields:
            oplog.append("user", "reading list updated", f"{x['title'][:120]}: " + ", ".join(f"{k}={v}" for k, v in fields.items())[:200])
        return {"ok": True}

    @app.get("/api/reading/paper/{pid}/position")
    async def get_position(pid: str) -> dict:
        """Where to open: Zotero's synced page (shared with Zotero desktop / iPad), else the platform's own."""
        x = paper_or_404(pid)
        _, att = reading.zotero_keys(x)
        if att and (z := zotero()) is not None:
            try:
                page = await asyncio.to_thread(z.get_page, att)
                if page is not None:
                    return {"page": page, "source": "zotero"}
            except ZoteroError:
                pass
        return {"page": x.get("position"), "source": "platform" if x.get("position") is not None else None}

    @app.post("/api/reading/paper/{pid}/position")
    async def set_position(pid: str, req: PositionIn) -> dict:
        x = paper_or_404(pid)
        if x.get("position") != req.page:
            await asyncio.to_thread(reading.update, pid, position=req.page)
        _, att = reading.zotero_keys(x)
        if att and (z := zotero()) is not None:
            background(z.set_page, att, req.page)
        return {"ok": True}

    @app.post("/api/reading/paper/{pid}/retry-pdf")
    async def retry_pdf(pid: str) -> dict:
        paper_or_404(pid)
        await asyncio.to_thread(reading.update, pid, pdf_error=None)
        background(reading.download_pdf, pid)
        return {"ok": True}

    # Highlights are not journaled (reading/annotations is excluded), so they may be saved while the
    # agent runs: the user highlights and asks the agent at the same time.
    @app.post("/api/reading/paper/{pid}/highlights")
    async def add_highlight(pid: str, req: HighlightIn) -> dict:
        paper_or_404(pid)
        if req.color not in COLORS:
            raise HTTPException(400, "bad colour")
        h = await view(reading.add_highlight, pid, req.model_dump())
        zotero_soon(pid)
        return h

    @app.post("/api/reading/paper/{pid}/highlights/{hid}")
    async def edit_highlight(pid: str, hid: str, req: HighlightEdit) -> dict:
        paper_or_404(pid)
        try:
            await asyncio.to_thread(reading.edit_highlight, pid, hid, comment=req.comment, color=req.color, delete=req.delete)
        except KeyError:
            raise HTTPException(404, "no such highlight")
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        zotero_soon(pid)
        return {"ok": True}

    @app.post("/api/reading/paper/{pid}/notes")
    async def save_paper_notes(pid: str, req: PaperNotes) -> dict:
        x = paper_or_404(pid)
        try:
            rel = await edit(reading.save_notes, pid, req.text, req.expect)
        except NotesConflict as exc:
            raise HTTPException(409, str(exc))
        oplog.append("user", "reading notes saved", f"{x['title'][:120]} → {rel}")
        schedule_snapshot(f"web: reading notes {rel}")
        zotero_soon(pid)
        return {"path": rel}

    @app.post("/api/reading/paper/{pid}/sync")
    async def sync_now(pid: str) -> dict:
        paper_or_404(pid)
        z = zotero()
        if z is None:
            raise HTTPException(503, "Zotero is not connected yet (no API key on the server)")
        try:
            await asyncio.to_thread(z.ensure_collection)
            out = await asyncio.to_thread(z.sync_paper, pid)
        except ZoteroError as exc:
            raise HTTPException(502, str(exc))
        return out

    @app.get("/api/weekly")
    async def get_weekly(week: str | None = None) -> dict:
        return await view(ws_.weekly, week)

    @app.post("/api/paper/save")
    async def paper_save(req: OverleafSave, request: Request) -> dict:
        if not who(request).owner:
            raise HTTPException(403, "owner only")
        try:
            out = await asyncio.to_thread(overleaf.save_draft, req.path, req.sha, req.text)
        except OverleafConflict as exc:
            raise HTTPException(409, str(exc))
        except OverleafError as exc:
            raise HTTPException(400, str(exc))
        schedule_snapshot(f"web: paper draft {req.path}")
        loc = overleaf.project_of(req.path)
        if loc:
            paper_pdf.build(loc[0])
        return out

    @app.get("/api/paper/{project}/pdf/status")
    async def paper_pdf_status(project: str, request: Request) -> dict:
        if not who(request).owner:
            raise HTTPException(403, "owner only")
        try:
            return await asyncio.to_thread(paper_pdf.status, project)
        except ValueError as exc:
            raise HTTPException(404, str(exc))

    @app.get("/api/paper/{project}/pdf")
    async def paper_pdf_file(project: str, request: Request):
        if not who(request).owner:
            raise HTTPException(403, "owner only")
        if project not in paper_pdf.projects or not paper_pdf.pdf_path(project).exists():
            raise HTTPException(404, "no PDF yet")
        return FileResponse(paper_pdf.pdf_path(project), media_type="application/pdf",
                            headers={"Cache-Control": "no-store"})

    @app.get("/api/paper/{project}/preview")
    async def paper_preview(project: str, request: Request) -> dict:
        if not who(request).owner:
            raise HTTPException(403, "owner only")
        try:
            return await asyncio.to_thread(overleaf.preview, project)
        except OverleafError as exc:
            raise HTTPException(400, str(exc))

    @app.post("/api/paper/{project}/publish")
    async def paper_publish(project: str, req: PaperPublish, request: Request) -> dict:
        if not who(request).owner:
            raise HTTPException(403, "owner only")
        try:
            out = await asyncio.to_thread(overleaf.publish, project, req.digest, req.message)
        except OverleafConflict as exc:
            raise HTTPException(409, str(exc))
        except OverleafError as exc:
            raise HTTPException(400, str(exc))
        if out["published"]:
            oplog.append("user", f"{project} clean version published to Overleaf", ", ".join(out["published"]))
        return out

    @app.get("/api/file")
    async def get_file(path: str, request: Request) -> dict:
        user = who(request)
        if not user.owner:
            data = await view(ws_.writing)
            if path not in {s["path"] for p in data["papers"] for s in p["sections"]}:
                raise HTTPException(404, "not found")
            audit(user, "viewed paper section", path)
        try:
            out = await asyncio.to_thread(ws_.read_text, path)
            loc = overleaf.project_of(path)
            if user.owner and loc and Path(path).suffix in (".tex", ".bib"):
                out = {**out, "editable": True, "sha": overleaf_sha(out["text"]), "paper": loc[0]}
            return out if user.owner else {**out, "text": strip_tex_comments(out["text"])}
        except ValueError as exc:
            raise HTTPException(404 if str(exc) == "not found" else 400, str(exc))
        except OSError:
            raise HTTPException(404, "not found")

    def schedule_snapshot(message: str) -> None:
        """Journal the web edit (git) once no agent run holds the lock; never blocks the request."""
        async def _snap() -> None:
            if not journal_ready.is_set():
                return
            async with lock:
                try:
                    await asyncio.to_thread(journal.snapshot, message)
                except Exception as exc:
                    oplog.append("system", "journal snapshot failed", f"{message}: {exc}"[:300])
        task = asyncio.create_task(_snap())
        runs.add(task)
        task.add_done_callback(runs.discard)

    async def edit(fn, *args):
        if lock.locked():
            raise HTTPException(409, "The agent is running — try again when it finishes")
        try:
            return await asyncio.to_thread(fn, *args)
        except EditConflict as exc:
            raise HTTPException(409, str(exc))
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        except OSError as exc:
            raise HTTPException(500, f"could not write: {exc}")

    @app.post("/api/edit/checkbox")
    async def edit_checkbox(req: CheckboxEdit) -> dict:
        if not checkbox_allowed(req.path):
            raise HTTPException(403, "checkboxes can only be changed in the tracker, task list and digests")
        out = await edit(ws_.set_checkbox, req.path, req.line, req.expect, req.checked)
        if req.path == "daily_tracker.md":  # a task taken into Today: tick it in research_tasks.md too
            synced = await edit(ws_.sync_task_tick, out["raw"], req.checked)
            if synced:
                out = {**out, "synced": synced}
        label = re.sub(r"^\s*- \[.\] ", "", req.expect)[:120]
        oplog.append("user", "ticked" if req.checked else "unticked", f"{req.path}:{req.line} {label}")
        schedule_snapshot(f"web: {'tick' if req.checked else 'untick'} {req.path}:{req.line}")
        return out

    @app.post("/api/today/task")
    async def today_task(req: TodayTask) -> dict:
        out = await edit(ws_.add_today_task, req.text)
        oplog.append("user", "task added to today", req.text[:160])
        schedule_snapshot("web: task added to today")
        return out

    @app.post("/api/today/task/remove")
    async def today_task_remove(req: TodayRemove) -> dict:
        await edit(ws_.remove_today_task, req.line, req.expect)
        oplog.append("user", "task removed from today", req.expect[:160])
        schedule_snapshot("web: task removed from today")
        return {"ok": True}

    @app.post("/api/edit/annotation-reply")
    async def annotation_reply(req: QuoteEdit) -> dict:
        def run() -> None:
            p = ws_.resolve(req.path)
            if p.suffix != ".md":
                raise ValueError("not markdown")
            lines = p.read_text(encoding="utf-8").split("\n")
            if not (1 <= req.line <= len(lines)) or not Workspace.ANNOT_HEAD.match(lines[req.line - 1]):
                raise EditConflict("the annotation moved — reload and try again")
            if req.end_line < req.line or any(not ln.startswith(">") for ln in lines[req.line - 1:req.end_line]):
                raise EditConflict("the annotation changed — reload and try again")
            ws_.reply_annotation(req.path, req.end_line, req.end_raw, req.text)
        await edit(run)
        oplog.append("user", "annotation reply", f"{req.path}:{req.line} {req.text[:200]}")
        schedule_snapshot(f"web: annotation reply {req.path}:{req.line}")
        return {"ok": True}

    @app.post("/api/edit/daily-message/replace")
    async def daily_message_replace(req: MessageReplace) -> dict:
        await edit(ws_.replace_message, req.line, req.end_line, req.end_raw, req.text)
        oplog.append("user", "notes to Claude edited", req.text[:200])
        schedule_snapshot("web: daily_tracker notes edited")
        return {"ok": True}

    @app.post("/api/edit/daily-message")
    async def daily_message(req: QuoteEdit) -> dict:
        if req.path != "daily_tracker.md":
            raise HTTPException(403, "messages go to daily_tracker.md only")
        def run() -> None:
            lines = ws_.resolve(req.path).read_text(encoding="utf-8").split("\n")
            if not (1 <= req.line <= len(lines)) or section_kind(lines[req.line - 1]) != "message":
                raise EditConflict("the tracker changed — reload and try again")
            ws_.append_quote(req.path, req.end_line, req.end_raw, req.text)
        await edit(run)
        oplog.append("user", "message to Claude", req.text[:200])
        schedule_snapshot("web: daily_tracker message")
        return {"ok": True}

    @app.post("/api/agent/undo")
    async def undo(req: UndoRequest) -> dict:
        if (status := journal_status()) is not None:
            raise HTTPException(503, status)
        if lock.locked():
            raise HTTPException(409, "agent running")
        async with lock:
            try:
                head = await asyncio.to_thread(journal.undo, req.commit)
            except UndoRejected as exc:
                raise HTTPException(400, str(exc))
            except UndoConflict as exc:
                oplog.append("user", "undo failed", f"{req.commit[:10]}: {exc}")
                raise HTTPException(409, f"Undo failed (conflicts with later changes): {exc}")
            except JournalUnavailable as exc:
                raise HTTPException(503, str(exc))
        oplog.append("user", "undo", f"reverted agent commit {req.commit[:10]}", commit=head)
        return {"head": head}

    @app.websocket("/ws/agent")
    async def agent_ws(ws: WebSocket):
        if verifier and not await asyncio.to_thread(verifier.verify, ws.headers.get(CF_HEADER)):
            await ws.close(code=4403)
            return
        if not origin_allowed(settings, ws.headers.get("origin")):
            await ws.close(code=4403)
            return
        await ws.accept()
        alive = True
        send_lock = asyncio.Lock()  # the run task and the receive loop both send

        async def send(event: dict) -> None:
            # A phone that locks its screen drops the socket; the run must keep going,
            # so a failed send just marks the socket dead and events are dropped.
            nonlocal alive
            if not alive:
                return
            async with send_lock:
                if not alive:
                    return
                try:
                    await ws.send_json(event)
                except Exception:
                    alive = False

        async def execute(msg: PromptMsg, run: AgentRun) -> None:
            # Caller already holds `lock`; we release it when the run is fully finished.
            sha, files, errors = None, [], []
            panel = msg.context.panel if msg.context else None
            oplog.append("agent", "run started", msg.prompt[:500], panel=panel)
            started = time.monotonic()
            try:
                # Tells the originating socket a run really began (so its errors are run
                # errors, ended only by `changes`), as opposed to no-run errors like "busy".
                await send({"kind": "started"})
                try:
                    await asyncio.to_thread(journal.snapshot, "pre-agent: user/sync changes")
                except Exception as exc:
                    await send({"kind": "error", "message": f"journal pre-snapshot failed: {exc}"})
                    return
                try:
                    async for event in run.events():
                        if event.get("kind") == "error":
                            errors.append(str(event.get("message", ""))[:300])
                        await send(event)
                except Exception as exc:
                    errors.append(f"agent failed: {exc}"[:300])
                    await send({"kind": "error", "message": f"agent failed: {exc}"})
                finally:
                    try:
                        sha = await asyncio.to_thread(journal.snapshot, f"agent: {msg.prompt[:60]}")
                        files = await asyncio.to_thread(journal.changed_files, sha) if sha else []
                    except Exception as exc:
                        await send({"kind": "error", "message": f"journal snapshot failed: {exc}"})
            finally:
                if current["run"] is run:
                    current["run"] = None
                lock.release()
                oplog.append("agent", "run failed" if errors else "run finished",
                             "; ".join(errors) or f"changed {len(files)} file(s)",
                             files=files[:50], commit=sha, seconds=round(time.monotonic() - started))
                await send({"kind": "changes", "commit": sha, "files": files})

        while True:
            message = await ws.receive()
            if message["type"] == "websocket.disconnect":
                break  # deliberately do NOT cancel the run
            raw = message.get("text")
            if raw is None:
                raw = (message.get("bytes") or b"").decode("utf-8", "replace")
            try:
                msg = parse_message(raw)
            except (ValueError, ValidationError) as exc:
                await send({"kind": "error", "message": f"bad message: {str(exc)[:300]}"})
                continue
            if isinstance(msg, CancelMsg):
                if current["run"] is None:
                    await send({"kind": "error", "message": "No task is running"})
                else:
                    oplog.append("user", "stop requested", "agent run cancelled from the web UI")
                    await current["run"].cancel()
                continue
            if (status := journal_status()) is not None:
                await send({"kind": "error", "message": status})
                continue
            if lock.locked():
                await send({"kind": "error", "message": "Another agent task is already running"})
                continue
            await lock.acquire()  # uncontended: returns without yielding
            try:
                ctx = msg.context.model_dump() if msg.context else None
                try:
                    shots = save_images(msg.images, (settings.state_dir or oplog.path.parent) / "agent_images")
                except ValueError as exc:
                    lock.release()
                    await send({"kind": "error", "message": f"image rejected: {exc}"})
                    continue
                run = AgentRun(settings.claude_bin, build_prompt(msg.prompt, ctx, shots),
                               settings.research_root, msg.session_id, settings.agent_timeout)
                current["run"] = run
                task = asyncio.create_task(execute(msg, run))
            except BaseException as exc:
                current["run"] = None
                lock.release()
                if isinstance(exc, Exception):
                    await send({"kind": "error", "message": f"could not start run: {exc}"})
                    continue
                raise
            runs.add(task)
            task.add_done_callback(runs.discard)
        alive = False

    # ---- Brain (3D concept map; UI = static frontend/public/brain/, data = brain.db) -------------------------
    brain = Brain(settings.brain_db or settings.research_root / "reading_log" / "brain" / "brain.db")
    brain_job: dict = {"running": False, "last": None, "error": None}

    def brain_call(fn, *args):
        try:
            return fn(*args)
        except BrainNotFound as exc:
            raise HTTPException(404, str(exc).strip("'\""))
        except FileNotFoundError:
            raise HTTPException(404, "brain database not found")
        except BrainError as exc:
            raise HTTPException(400, str(exc))
        except AINotConfigured as exc:
            raise HTTPException(503, str(exc))
        except RuntimeError as exc:
            raise HTTPException(502, str(exc)[:300])

    def brain_body(raw) -> dict:
        return raw if isinstance(raw, dict) else {}

    @app.get("/api/brain/health")
    def brain_health() -> dict:
        return brain.health()

    @app.get("/api/brain/graph")
    def brain_graph() -> dict:
        return brain_call(brain.graph)

    @app.get("/api/brain/state")
    def brain_state() -> dict:
        return brain_call(brain.state)

    @app.get("/api/brain/last-update")
    def brain_last_update() -> dict:
        return brain_call(brain.last_update)

    @app.get("/api/brain/screenshots/{name}")
    def brain_screenshot(name: str):
        f = brain_call(brain.screenshot, name)
        return FileResponse(f, media_type="image/png", headers={"Cache-Control": "private, max-age=86400"})

    @app.get("/api/brain/nodes/{node_id:path}/highlights")
    def brain_highlights(node_id: str) -> dict:
        return {"highlights": brain_call(brain.highlights, node_id)}

    @app.get("/api/brain/nodes/{node_id:path}/context")
    def brain_context(node_id: str) -> dict:
        return {"contexts": brain_call(brain.context, node_id)}

    @app.get("/api/brain/nodes/{node_id:path}/discover")
    def brain_discover(node_id: str) -> dict:
        return {"candidates": brain_call(brain.discover, node_id)}

    @app.get("/api/brain/nodes/{node_id:path}/messages")
    def brain_messages(node_id: str) -> dict:
        return {"messages": brain_call(brain.messages, node_id)}

    @app.post("/api/brain/nodes/{node_id:path}/messages/clear")
    def brain_clear_messages(node_id: str) -> dict:
        brain_call(brain.clear_messages, node_id)
        return {"ok": True}

    @app.post("/api/brain/nodes/create")
    def brain_create_node(body: dict) -> dict:
        b = brain_body(body)
        node = brain_call(lambda: brain.create_node(
            b.get("type") or "concept", b.get("label") or "", b.get("detail"), b.get("weight"), b.get("domains"),
            subtype=b.get("subtype"), author=b.get("author"), year=b.get("year"), doi=b.get("doi"), venue=b.get("venue")))
        return {"ok": True, "node": node}

    @app.post("/api/brain/nodes/{node_id:path}/merge-into")
    def brain_merge(node_id: str, body: dict) -> dict:
        return {"ok": True, "result": brain_call(brain.merge, node_id, brain_body(body).get("target_id") or "")}

    BRAIN_NODE_OPS = {
        "confirm": lambda nid, b: brain.confirm_node(nid, b.get("status")),
        "note": lambda nid, b: brain.set_note(nid, b.get("text", "")),
        "rename": lambda nid, b: brain.rename(nid, b.get("label", "")),
        "detail": lambda nid, b: brain.set_detail(nid, b.get("text", "")),
        "subtype": lambda nid, b: brain.set_subtype(nid, b.get("subtype")),
        "type": lambda nid, b: brain.set_type(nid, b.get("type") or "", b.get("subtype")),
        "domains": lambda nid, b: brain.set_domains(nid, b.get("domains", [])),
    }

    @app.post("/api/brain/state/node/{node_id:path}/{op}")
    def brain_node_op(node_id: str, op: str, body: dict) -> dict:
        fn = BRAIN_NODE_OPS.get(op)
        if fn is None:
            raise HTTPException(404, "unknown state endpoint")
        brain_call(fn, node_id, brain_body(body))
        return {"ok": True}

    @app.post("/api/brain/state/edge/{edge_id}/confirm")
    def brain_edge_confirm(edge_id: int, body: dict) -> dict:
        brain_call(brain.confirm_edge, edge_id, brain_body(body).get("status"))
        return {"ok": True}

    @app.post("/api/brain/state/question/{question_id:path}/answer")
    def brain_answer(question_id: str, body: dict) -> dict:
        brain_call(brain.set_answer, question_id, brain_body(body).get("text", ""))
        return {"ok": True}

    @app.post("/api/brain/edges/create")
    def brain_create_edge(body: dict) -> dict:
        b = brain_body(body)
        res = brain_call(brain.create_edge, b.get("source") or "", b.get("target") or "", b.get("type") or "relates_to",
                         b.get("label"))
        return {"ok": True, **res}

    @app.post("/api/brain/edges/{edge_id}/delete")
    def brain_delete_edge(edge_id: int) -> dict:
        brain_call(brain.delete_edge, edge_id)
        return {"ok": True}

    @app.post("/api/brain/extract")
    def brain_extract(body: dict) -> dict:
        return brain_call(brain.extract, brain_body(body).get("text") or "")

    @app.post("/api/brain/explain")
    def brain_explain(body: dict):
        b = brain_body(body)
        if not b.get("node_id"):
            raise HTTPException(400, "missing node_id")
        gen = brain_call(brain.explain, str(b["node_id"]), str(b.get("question") or ""))
        return StreamingResponse(gen, media_type="text/plain; charset=utf-8",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    def brain_import_run() -> None:
        try:
            imp = importer_for(brain, settings.zotero_file, log=lambda m: None)
            if imp is None:
                brain_job["error"] = "Zotero is not configured"
                return
            stats = imp.run()
            brain_job.update(last=stats, error=None)
            oplog.append("system", "brain import",
                         f"+{stats['new_highlights']} highlights, +{stats['new_sources']} sources, "
                         f"{stats['updated']} updated, {stats['removed']} removed")
        except (ZoteroError, ImportBusy) as exc:
            brain_job["error"] = str(exc)[:300]
        except Exception as exc:
            brain_job["error"] = f"{type(exc).__name__}: {exc}"[:300]
            oplog.append("system", "brain import failed", brain_job["error"])
        finally:
            brain_job["running"] = False

    @app.get("/api/brain/import")
    def brain_import_status() -> dict:
        return {"running": brain_job["running"], "error": brain_job["error"], "last": brain_call(brain.last_update),
                "zotero_configured": load_config(settings.zotero_file) is not None}

    @app.post("/api/brain/import")
    def brain_import_start() -> dict:
        if brain_job["running"]:
            raise HTTPException(409, "an import is already running")
        if load_config(settings.zotero_file) is None:
            raise HTTPException(503, "Zotero is not configured")
        brain_job.update(running=True, error=None)
        oplog.append("user", "brain refresh from Zotero requested")
        threading.Thread(target=brain_import_run, name="brain-import", daemon=True).start()
        return {"started": True}

    if settings.static_dir:
        static_root = Path(settings.static_dir)

        app.mount("/", StaticFiles(directory=settings.static_dir, html=True), name="static")
    return app
