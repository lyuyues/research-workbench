"""Live PDF of the platform paper draft (tectonic, ~/.local/bin/tectonic, installed 2026-11-17 with the user's OK).

The draft is copied into a build dir (no .git, no template samples) and compiled; the PDF shows the draft as it
will look on Overleaf (Claude's notes are TeX comments, so they never appear in the PDF).

A build starts when a draft file is saved on the platform, or when the preview page polls and any draft .tex/.bib
is newer than the last build (so edits made over ssh also show up). One build per project at a time; changes made
during a build trigger one more build right after.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

from .projects import Projects

TECTONIC = Path.home() / ".local/bin/tectonic"
FONT = "libertinusmath-regular.otf"  # acmart (XeTeX) asks for it by this lower-case name


class PaperPdf:
    def __init__(self, research_root: Path, state_dir: Path, projects: Projects | None = None):
        self.research = Path(research_root)
        self._projects = projects or Projects(self.research)
        self.out = Path(state_dir) / "pdf"
        self.build_root = Path.home() / ".cache/paper-build"
        self._lock = threading.Lock()
        self._st: dict[str, dict] = {}

    @property
    def projects(self) -> list[str]:
        return self._projects.names()

    def draft(self, p: str) -> Path:
        return self.research / self._projects.paper_dir(p)

    def pdf_path(self, p: str) -> Path:
        return self.out / f"{p}.pdf"

    def _latest_edit(self, p: str) -> float:
        d = self.draft(p)
        newest = 0.0
        for f in d.rglob("*"):
            if f.suffix in (".tex", ".bib", ".cls", ".sty") and ".git" not in f.parts and "samples" not in f.parts:
                try:
                    newest = max(newest, f.stat().st_mtime)
                except OSError:
                    pass
        return newest

    def status(self, p: str, auto: bool = True) -> dict:
        if p not in self.projects:
            raise ValueError("unknown paper")
        st = dict(self._st.get(p) or {})
        pdf = self.pdf_path(p)
        st.setdefault("state", "idle")
        st["available"] = TECTONIC.exists()
        st["pdf_mtime"] = int(pdf.stat().st_mtime * 1000) if pdf.exists() else None
        if auto and st["available"] and st["state"] != "building":
            if self._latest_edit(p) > (st.get("source_time") or 0):
                self.build(p)
                st = {**st, "state": "building"}
        return st

    def build(self, p: str) -> None:
        with self._lock:
            cur = self._st.setdefault(p, {"state": "idle"})
            if cur.get("state") == "building":
                cur["again"] = True
                return
            cur.update(state="building", started=int(time.time() * 1000), again=False)
        threading.Thread(target=self._run, args=(p,), daemon=True).start()

    def _run(self, p: str) -> None:
        while True:
            src_time = self._latest_edit(p)
            t0 = time.time()
            try:
                result = self._compile(p)
            except Exception as exc:  # noqa: BLE001 - report any failure to the page
                result = {"state": "error", "error": str(exc)}
            with self._lock:
                st = self._st[p]
                st.update(result, source_time=src_time, finished=int(time.time() * 1000), seconds=round(time.time() - t0))
                if st.pop("again", False):
                    st.update(state="building", started=int(time.time() * 1000), again=False)
                    continue
                if st["state"] == "building":
                    st["state"] = "ok"
                return

    def _compile(self, p: str) -> dict:
        b = self.build_root / p
        b.mkdir(parents=True, exist_ok=True)
        subprocess.run(["rsync", "-a", "--delete", "--exclude=.git", "--exclude=samples", "--exclude=/main.pdf",
                        "--exclude=" + FONT, "--exclude=main.log", f"{self.draft(p)}/", f"{b}/"], check=True,
                       capture_output=True, timeout=60)
        if not (b / FONT).exists():
            data = subprocess.run([str(TECTONIC), "-X", "bundle", "cat", "LibertinusMath-Regular.otf"],
                                  capture_output=True, timeout=300).stdout
            if data:
                (b / FONT).write_bytes(data)
        r = subprocess.run([str(TECTONIC), "-X", "compile", "--keep-logs", "main.tex"], cwd=b, capture_output=True,
                           text=True, timeout=600)
        pdf = b / "main.pdf"
        if r.returncode != 0 or not pdf.exists():
            return {"state": "error", "error": self._errors(r.stdout + r.stderr, b)}
        self.out.mkdir(parents=True, exist_ok=True)
        tmp = self.pdf_path(p).with_suffix(".tmp")
        shutil.copyfile(pdf, tmp)
        os.replace(tmp, self.pdf_path(p))
        warn = [ln for ln in (r.stderr or "").splitlines() if re.search(r"undefined|Citation .* undefined", ln)]
        return {"state": "ok", "error": None, "warnings": warn[:8]}

    @staticmethod
    def _errors(out: str, b: Path) -> str:
        lines = [ln for ln in out.splitlines() if ln.startswith("error") or "Error" in ln]
        log = b / "main.log"
        if log.exists():
            txt = log.read_text(errors="replace").splitlines()
            for i, ln in enumerate(txt):
                if ln.startswith("!"):
                    lines.append("\n".join(txt[i:i + 4]))
                    break
        return "\n".join(lines[:8]) or "compile failed"
