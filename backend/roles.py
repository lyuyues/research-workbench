"""Who may see what.

The owner (RP_ACCESS_EMAIL) gets everything. Viewers are listed in a JSON file the owner edits
(RP_ACCESS_FILE, default ~/.config/research-platform/access.json):

    {"viewers": {"colleague@example.edu": ["writing"], "ra@example.com": ["study-data"]}}

A viewer is read-only: GET only, no agent, no edits, no logs, and only the panels listed —
and only panels in VIEWER_PANELS can be granted. Anyone else who gets past Cloudflare Access
is refused. The file is re-read when it changes; if it is unreadable or malformed, nobody but
the owner gets in (fail closed).
"""
from __future__ import annotations

import json
import re
import threading
from dataclasses import dataclass, field
from pathlib import Path

VIEWER_PANELS = ("writing", "study-data")
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


@dataclass(frozen=True)
class User:
    email: str | None
    role: str  # "owner" | "viewer"
    panels: frozenset[str] = field(default_factory=frozenset)

    @property
    def owner(self) -> bool:
        return self.role == "owner"

    def can(self, panel: str) -> bool:
        return self.owner or panel in self.panels


OWNER_LOCAL = User(None, "owner")  # access checks off (local dev / tests)


class AccessList:
    def __init__(self, path: Path | None):
        self.path = Path(path) if path else None
        self._lock = threading.Lock()
        self._key: tuple | None = None
        self._viewers: dict[str, frozenset[str]] = {}
        self.error: str | None = None

    def viewers(self) -> dict[str, frozenset[str]]:
        if self.path is None:
            return {}
        try:
            st = self.path.stat()
        except FileNotFoundError:
            self._key, self._viewers, self.error = None, {}, None
            return {}
        except OSError as exc:
            self._viewers, self.error = {}, f"cannot read access file: {exc}"
            return {}
        key = (st.st_mtime_ns, st.st_size)
        with self._lock:
            if key != self._key:
                self._key = key
                try:
                    self._viewers, self.error = parse(self.path.read_text(encoding="utf-8")), None
                except (OSError, ValueError) as exc:
                    self._viewers, self.error = {}, f"access file ignored: {exc}"
            return self._viewers

    def user(self, email: str | None, owner: str | None) -> User | None:
        """None = not allowed in."""
        if not email:
            return None
        email = email.strip().lower()
        if owner and email == owner.strip().lower():
            return User(email, "owner")
        panels = self.viewers().get(email)
        return User(email, "viewer", panels) if panels else None


def parse(text: str) -> dict[str, frozenset[str]]:
    data = json.loads(text)
    if not isinstance(data, dict) or not isinstance(data.get("viewers", {}), dict):
        raise ValueError('expected {"viewers": {"email": ["panel", ...]}}')
    out: dict[str, frozenset[str]] = {}
    for email, panels in data.get("viewers", {}).items():
        if not isinstance(email, str) or not EMAIL.match(email.strip()):
            raise ValueError(f"bad email {email!r}")
        if not isinstance(panels, list) or not all(isinstance(p, str) for p in panels):
            raise ValueError(f"panels for {email} must be a list of panel ids")
        bad = [p for p in panels if p not in VIEWER_PANELS]
        if bad:
            raise ValueError(f"{email}: panels {bad} cannot be shared (allowed: {list(VIEWER_PANELS)})")
        out[email.strip().lower()] = frozenset(panels)
    return out


# ------------------------------------------------------------------ request rules
# Viewer-reachable API routes, by the panel that grants them.
VIEWER_API = {
    "/api/health": None, "/api/me": None, "/api/panels": None,
    "/api/writing": "writing", "/api/file": "writing",
    "/api/study-data": "study-data", "/api/study-files": "study-data", "/api/study-files/raw": "study-data",
}


def viewer_may(user: User, method: str, path: str) -> bool:
    """Coarse route gate for viewers (endpoints then filter what they return)."""
    if method not in ("GET", "HEAD"):
        return False
    if path in VIEWER_API:
        need = VIEWER_API[path]
        return need is None or user.can(need)
    if path.startswith("/reports/"):
        return user.can("study-data")
    if path.startswith(("/api", "/ws", "/docs", "/redoc", "/openapi")):
        return False
    return True  # the static app shell: /, /assets/*, icons


_TEX_COMMENT = re.compile(r"(?<!\\)%.*$")


def strip_tex_comments(text: str) -> str:
    """Drop LaTeX comments (private notes, TODOs) from a section before showing it to a viewer."""
    out = []
    for line in text.split("\n"):
        if line.lstrip().startswith("%"):
            continue
        out.append(_TEX_COMMENT.sub("", line).rstrip())
    return "\n".join(out)


VIEWER_PROJECT_FILE = re.compile(r"^$")  # project files colleagues with the study-data role may read


def viewer_study_index(idx: dict) -> dict:
    """Study-files index reduced to what a viewer may see."""
    children = [{"id": c["id"], "n": c["n"], "bio_info": None,
                 "tabs": {t: (fs if t in VIEWER_STUDY_TABS else []) for t, fs in c["tabs"].items()}}
                for c in idx.get("children", [])]
    shared = [f for f in idx.get("project_files", []) if VIEWER_PROJECT_FILE.match(f["path"])]
    return {**idx, "children": children, "bio_source": None, "project_files": shared, "general": []}


def viewer_writing(data: dict) -> dict:
    """Writing view for a viewer: LaTeX sections only (no private planning docs)."""
    return {"papers": [{**p, "docs": [], "pdf": None} for p in data.get("papers", [])]}
