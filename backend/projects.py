"""The research projects the platform knows about: <Research>/projects.yaml.

    projects:
      - name: Alpha                 # id: letters, digits, - and _ (used in URLs and file names)
        code: S                     # task-ID prefix in research_tasks.md (S-1.2); default = first letter
        dir: Alpha                  # project folder, relative to the Research root; default = name
        title: Sleep and screen time  # optional, shown in the UI
        paper: Alpha/paper/overleaf # optional: the paper draft (LaTeX), for Writing / live PDF
        data: ~/study/sleep         # optional: raw data folder (read-only to the platform)
        docs: [Alpha/0_SPINE.md]    # optional: key documents listed with the paper; default <dir>/0_SPINE.md, 1_NEXT.md

Everything else (story canvas, meetings, tasks) follows from the folder: <dir>/story/canvas.json, ...
A missing file means "no projects yet"; the agent can write one ("set up my workspace").
The file is re-read when it changes, so edits show up without a restart.
"""
from __future__ import annotations

import re
import threading
from dataclasses import dataclass
from pathlib import Path

from ruamel.yaml import YAML

NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,39}$")
CODE = re.compile(r"^[A-Z]{1,4}$")
FILE = "projects.yaml"


@dataclass(frozen=True)
class Project:
    name: str
    code: str
    dir: str
    title: str = ""
    paper: str | None = None
    data: str | None = None
    docs: tuple[str, ...] = ()

    def public(self) -> dict:
        return {"name": self.name, "code": self.code, "dir": self.dir, "title": self.title or self.name,
                "paper": self.paper, "has_data": bool(self.data)}


def parse(doc) -> list[Project]:
    """Validate the parsed YAML; raises ValueError with a readable message."""
    items = (doc or {}).get("projects") if isinstance(doc, dict) else None
    if items is None:
        return []
    if not isinstance(items, list):
        raise ValueError("projects.yaml: 'projects' must be a list")
    out, names, codes = [], set(), set()
    for i, it in enumerate(items, 1):
        if not isinstance(it, dict):
            raise ValueError(f"projects.yaml: entry {i} must be a mapping with at least 'name'")
        name = str(it.get("name", ""))
        if not NAME.match(name):
            raise ValueError(f"projects.yaml: entry {i}: bad name {name!r} (letters, digits, - and _)")
        code = str(it.get("code") or name[0]).upper()
        if not CODE.match(code):
            raise ValueError(f"projects.yaml: {name}: code must be 1–4 capital letters")
        if name.lower() in names or code in codes:
            raise ValueError(f"projects.yaml: duplicate name or code ({name} / {code})")
        names.add(name.lower()); codes.add(code)
        d = str(it.get("dir") or name)
        if d.startswith("/") or ".." in Path(d).parts:
            raise ValueError(f"projects.yaml: {name}: dir must be inside the Research folder")
        opt = lambda k: (str(it[k]) if it.get(k) not in (None, "") else None)  # noqa: E731
        docs = it.get("docs") or [f"{d}/0_SPINE.md", f"{d}/1_NEXT.md"]
        if not isinstance(docs, list) or any(not isinstance(x, str) or x.startswith("/") or ".." in Path(x).parts for x in docs):
            raise ValueError(f"projects.yaml: {name}: docs must be a list of paths inside the Research folder")
        out.append(Project(name=name, code=code, dir=d, title=str(it.get("title") or ""), paper=opt("paper"), data=opt("data"),
                           docs=tuple(docs)))
    return out


class Projects:
    def __init__(self, research_root: Path):
        self.root = Path(research_root)
        self._lock = threading.Lock()
        self._cache: tuple[float, list[Project]] | None = None

    @property
    def path(self) -> Path:
        return self.root / FILE

    def all(self) -> list[Project]:
        try:
            mtime = self.path.stat().st_mtime
        except FileNotFoundError:
            return []
        with self._lock:
            if self._cache and self._cache[0] == mtime:
                return self._cache[1]
            projects = parse(YAML(typ="safe").load(self.path.read_text(encoding="utf-8")))
            self._cache = (mtime, projects)
            return projects

    def names(self) -> list[str]:
        return [p.name for p in self.all()]

    def get(self, name: str) -> Project:
        for p in self.all():
            if p.name == name:
                return p
        raise ValueError(f"unknown project {name!r} (add it to {FILE})")

    def paper_dir(self, name: str) -> str:
        """The paper draft folder (relative to the Research root): `paper:` or <dir>/paper/overleaf."""
        p = self.get(name)
        return (p.paper or f"{p.dir}/paper/overleaf").rstrip("/")

    def by_code(self) -> dict[str, Project]:
        return {p.code: p for p in self.all()}
