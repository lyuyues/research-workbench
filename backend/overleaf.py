"""Paper workflow: we write on the platform, Overleaf only ever receives the clean version.

  draft   ~/Research/<P>/paper/overleaf/          the user + Claude work here (Claude's %% notes, TODOs, ⚠️ questions OK)
  clone   ~/overleaf/<P>                          git clone of the Overleaf project (what collaborators see)
  base    state/paper_sync.json {P: commit}       the Overleaf commit the draft last agreed with

pull_in   collaborators' Overleaf edits since `base` are 3-way merged into the draft (git merge-file), base := HEAD.
preview   pull_in, then clean(draft) vs clone per file → diffs + any remaining AI traces (leaks).
publish   same computation, refuses if anything changed since the preview or any trace is left; commit as the user, push.

clean() removes Claude's watermarks: `%%` comment lines, `% TODO/NOTE/FIXME` comments (whole-line or trailing), any
comment mentioning Claude/AI/🤖/⚠️/批注/auto-generated, and comment-only lines with Chinese. LaTeX code and the user's
own commented-out code (`% \\begin{figure}` …) stay.
"""
from __future__ import annotations

import difflib
import hashlib
import json
import os
import re
import subprocess
import tempfile
import threading
from pathlib import Path

from .projects import Projects

TEXT_EXT = {".tex", ".bib"}
SKIP_DIRS = {"archived", "_archive", ".git"}

AI_WORDS = re.compile(r"claude|\bai\b|🤖|⚠️|批注|auto-?generated|anthropic|\bllm\b|gpt", re.I)
CJK = re.compile(r"[一-鿿]")
TODO = re.compile(r"\b(TODO|NOTE|FIXME|XXX)\b")
LEAK = re.compile(r"claude|🤖|⚠️|question for you|批注|auto-?generated|anthropic", re.I)


class OverleafError(Exception):
    pass


class OverleafConflict(OverleafError):
    pass


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _comment_start(line: str) -> int:
    """Index of the first unescaped % (LaTeX comment), or -1."""
    i = 0
    while True:
        i = line.find("%", i)
        if i < 0:
            return -1
        bs = 0
        j = i - 1
        while j >= 0 and line[j] == "\\":
            bs += 1
            j -= 1
        if bs % 2 == 0:
            return i
        i += 1


def _is_watermark(comment: str) -> bool:
    body = comment.lstrip("%").strip()
    return (comment.startswith("%%") or bool(TODO.match(body)) or bool(AI_WORDS.search(body))
            or bool(CJK.search(body)))


def clean(text: str) -> str:
    out: list[str] = []
    for line in text.split("\n"):
        c = _comment_start(line)
        if c < 0:
            out.append(line)
            continue
        code, comment = line[:c], line[c:]
        if not code.strip():
            if _is_watermark(comment):
                continue  # drop the whole comment line
            out.append(line)
        elif _is_watermark(comment):
            out.append(code.rstrip() + ("%" if comment.rstrip() == "%" else ""))
        else:
            out.append(line)
    s = "\n".join(out)
    s = re.sub(r"\n{3,}", "\n\n", s)  # removed blocks must not leave big gaps
    return s


def leaks(text: str) -> list[str]:
    return [f"{n}: {ln.strip()[:120]}" for n, ln in enumerate(text.split("\n"), 1) if LEAK.search(ln)]


class Overleaf:
    def __init__(self, research_root: Path, state_dir: Path, clones: Path | None = None, projects: Projects | None = None):
        self.research = Path(research_root)
        self.projects = projects or Projects(self.research)
        self.clones = Path(clones or Path.home() / "overleaf")
        self.state = Path(state_dir) / "paper_sync.json"
        self._lock = threading.Lock()

    # ---- paths ------------------------------------------------------------------------------------------------
    def draft_dir(self, p: str) -> Path:
        return self.research / self.projects.paper_dir(p)

    def clone_dir(self, p: str) -> Path:
        return self.clones / p

    def ready(self, p: str) -> bool:
        return p in self.projects.names() and (self.clone_dir(p) / ".git").is_dir() and self.draft_dir(p).is_dir()

    def project_of(self, path: str) -> tuple[str, str] | None:
        for p in self.projects.names():
            pre = f"{self.projects.paper_dir(p)}/"
            if path.startswith(pre) and ".." not in Path(path).parts:
                return p, path[len(pre):]
        return None

    # ---- state ------------------------------------------------------------------------------------------------
    def _bases(self) -> dict:
        try:
            return json.loads(self.state.read_text())
        except (OSError, ValueError):
            return {}

    def _set_base(self, p: str, commit: str) -> None:
        b = self._bases()
        b[p] = commit
        self.state.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state.with_suffix(".tmp")
        tmp.write_text(json.dumps(b, indent=1))
        os.replace(tmp, self.state)

    def _git(self, p: str, *args: str, timeout: int = 90) -> str:
        r = subprocess.run(["git", "-C", str(self.clone_dir(p)), *args], capture_output=True, text=True, timeout=timeout)
        if r.returncode:
            msg = (r.stderr or r.stdout).strip()
            raise OverleafError(msg.splitlines()[-1] if msg else "git failed")
        return r.stdout

    def _head(self, p: str) -> str:
        return self._git(p, "rev-parse", "HEAD").strip()

    def _fetch(self, p: str) -> None:
        self._git(p, "fetch", "-q", "origin")
        self._git(p, "reset", "-q", "--hard", "origin/master")

    # ---- files ------------------------------------------------------------------------------------------------
    def _publishable(self, p: str) -> list[tuple[str, str]]:
        """(file, mode): "clean" = paper text (texfiles/**, root *.bib) gets the full watermark strip;
        "leaks" = other root .tex (main.tex, _setup.tex) only loses lines that name Claude. Template samples untouched."""
        d = self.draft_dir(p)
        tracked = {f for f in self._git(p, "ls-files").splitlines() if Path(f).suffix in TEXT_EXT}
        drafts = {f.relative_to(d).as_posix() for f in d.rglob("*") if f.is_file() and f.suffix in TEXT_EXT}
        out = []
        for rel in sorted(tracked | drafts):
            parts = Path(rel).parts
            if parts[0] == "texfiles" and not (set(parts[1:-1]) & SKIP_DIRS):
                out.append((rel, "clean"))
            elif len(parts) == 1 and rel.endswith(".bib"):
                out.append((rel, "clean"))
            elif len(parts) == 1 and rel in tracked:
                out.append((rel, "leaks"))
        return out

    # ---- sync -------------------------------------------------------------------------------------------------
    def pull_in(self, p: str) -> dict:
        """Merge collaborators' Overleaf edits since `base` into the draft."""
        self._fetch(p)
        head, base = self._head(p), self._bases().get(p)
        if not base:
            self._set_base(p, head)
            return {"merged": [], "conflicts": []}
        if base == head:
            return {"merged": [], "conflicts": []}
        merged, conflicts = [], []
        changed = [f for f in self._git(p, "diff", "--name-only", base, head).splitlines() if Path(f).suffix in TEXT_EXT]
        for rel in changed:
            theirs_p = self.clone_dir(p) / rel
            ours_p = self.draft_dir(p) / rel
            if not theirs_p.exists():
                continue  # deleted on Overleaf: keep our draft, publishing will re-add it only if the user publishes
            if not ours_p.exists():
                ours_p.parent.mkdir(parents=True, exist_ok=True)
                ours_p.write_text(theirs_p.read_text(encoding="utf-8"), encoding="utf-8")
                merged.append(rel)
                continue
            try:
                base_txt = self._git(p, "show", f"{base}:{rel}")
            except OverleafError:
                base_txt = ""
            with tempfile.TemporaryDirectory() as t:
                bf = Path(t) / "base"
                bf.write_text(base_txt, encoding="utf-8")
                r = subprocess.run(["git", "merge-file", "-p", "-L", "platform draft", "-L", "last sync", "-L", "Overleaf",
                                    str(ours_p), str(bf), str(theirs_p)], capture_output=True, text=True)
            if r.returncode < 0 or r.returncode > 127:
                raise OverleafError(f"merge failed for {rel}")
            if r.stdout != ours_p.read_text(encoding="utf-8"):
                ours_p.write_text(r.stdout, encoding="utf-8")
                merged.append(rel)
            if r.returncode > 0:
                conflicts.append(rel)
        self._set_base(p, head)
        return {"merged": merged, "conflicts": conflicts}

    def _plan(self, p: str) -> dict:
        files = []
        for rel, mode in self._publishable(p):
            dp, cp = self.draft_dir(p) / rel, self.clone_dir(p) / rel
            if not dp.exists():
                continue
            txt = dp.read_text(encoding="utf-8")
            new = clean(txt) if mode == "clean" else "\n".join(ln for ln in txt.split("\n") if not LEAK.search(ln))
            old = cp.read_text(encoding="utf-8") if cp.exists() else ""
            if new == old:
                continue
            diff = "".join(difflib.unified_diff(old.splitlines(True), new.splitlines(True), f"Overleaf/{rel}",
                                                f"clean/{rel}", n=2))
            files.append({"path": rel, "new": not cp.exists(), "diff": diff, "leaks": leaks(new),
                          "conflict": "<<<<<<<" in new, "_text": new})
        digest = sha(json.dumps([[f["path"], f["_text"]] for f in files]))
        return {"files": files, "digest": digest}

    def preview(self, p: str) -> dict:
        if not self.ready(p):
            raise OverleafError(f"{p}: no Overleaf clone on the server")
        with self._lock:
            pulled = self.pull_in(p)
            plan = self._plan(p)
        return {"project": p, "pulled": pulled, "digest": plan["digest"],
                "files": [{k: v for k, v in f.items() if k != "_text"} for f in plan["files"]]}

    def publish(self, p: str, digest: str, message: str = "") -> dict:
        if not self.ready(p):
            raise OverleafError(f"{p}: no Overleaf clone on the server")
        with self._lock:
            self.pull_in(p)
            plan = self._plan(p)
            if plan["digest"] != digest:
                raise OverleafConflict("Something changed since the preview (draft or Overleaf). Review the new preview.")
            if not plan["files"]:
                return {"ok": True, "published": []}
            bad = [f["path"] for f in plan["files"] if f["leaks"] or f["conflict"]]
            if bad:
                raise OverleafConflict("Not published — AI traces or merge conflicts left in: " + ", ".join(bad))
            for f in plan["files"]:
                cp = self.clone_dir(p) / f["path"]
                cp.parent.mkdir(parents=True, exist_ok=True)
                cp.write_text(f["_text"], encoding="utf-8")
            names = [f["path"] for f in plan["files"]]
            self._git(p, "add", "--", *names)
            short = ", ".join(Path(n).stem for n in names[:4]) + (" …" if len(names) > 4 else "")
            self._git(p, "commit", "-q", "-m", message.strip() or f"Update {short}")
            try:
                self._git(p, "push", "-q", "origin", "HEAD:master", timeout=120)
            except (OverleafError, subprocess.TimeoutExpired) as exc:
                self._git(p, "reset", "-q", "--hard", "origin/master")
                raise OverleafConflict(f"Overleaf did not accept the push ({exc}). Preview again.")
            self._set_base(p, self._head(p))
            return {"ok": True, "published": names}

    # ---- draft editing on the platform -------------------------------------------------------------------------
    def save_draft(self, path: str, base_sha: str, text: str) -> dict:
        loc = self.project_of(path)
        if not loc:
            raise OverleafError("not a paper file")
        f = self.draft_dir(loc[0]) / loc[1]
        with self._lock:
            if not f.is_file():
                raise OverleafError("file not found")
            if sha(f.read_text(encoding="utf-8")) != base_sha:
                raise OverleafConflict("This file changed since you opened it. Copy your edit, reload, apply again.")
            f.write_text(text if text.endswith("\n") else text + "\n", encoding="utf-8")
        return {"ok": True, "sha": sha(f.read_text(encoding="utf-8"))}
