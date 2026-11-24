"""On-demand English audio brief of a paper (Reading panel 🎧 button).

PDF text -> `claude -p` writes a ~10 min spoken English brief -> Edge TTS mp3. Runs on the server as a
detached job with the audiobook venv (edge-tts + pymupdf); the API only starts it and reads its status.

Layout under <audiobook root>:
  library/papers/book.json   "Paper briefs" book: chapters carry "pid" -> it also shows up in the podcast feed
  library/papers/NNN.mp3     one brief per paper (regenerating a paper replaces its file, keeps its number)
  library/papers/NNN.txt     the script that was read out
  paper_jobs/<pid>.json      {"state": "writing" | "speaking" | "done" | "error", "started", "error"?}

CLI (server): python backend/paper_audio.py make --root ~/audiobooks --pid P --pdf F --title T [--claude claude]
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

BOOK = "papers"
VOICE = "en-US-AvaNeural"
MAX_INPUT = 120_000  # characters of paper text handed to Claude
STALE = 40 * 60  # a job older than this that never finished is treated as dead
SAFE_PID = re.compile(r"^[\w.\-]{1,120}$")
REFS = re.compile(r"^\s*(references|bibliography|works cited)\s*$", re.I | re.M)

PROMPT = """You are writing the script for a short solo podcast episode that explains one research paper to a \
busy HCI PhD researcher who will listen while walking or commuting.

Write about 1,400 words (roughly 10 minutes spoken) in natural spoken English. Cover, in this order:
1. A one-sentence hook: what problem the paper tackles and why it matters.
2. The setting and research questions.
3. What the authors built or did: the system, method, participants and study design, with concrete numbers.
4. The key findings, with the specific results that support them.
5. Limitations and open questions, including ones the authors do not state.
6. Two or three takeaways for someone designing interactive or AI systems.

Rules: plain prose only, no headings, bullet points, markdown, URLs, citations or reference numbers. Say \
acronyms in full the first time. Do not invent results; if something is unclear in the text, say so. Start \
with "This is a paper brief on" followed by the title. Output only the script.

Paper title: {title}

Paper text:
{text}
"""


# ---------------------------------------------------------------- paths / status

def book_dir(root: Path) -> Path:
    return root / "library" / BOOK


def _job_file(root: Path, pid: str) -> Path:
    if not SAFE_PID.match(pid):
        raise ValueError("bad paper id")
    return root / "paper_jobs" / f"{pid}.json"


def _write_json(p: Path, obj) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1))
    os.replace(tmp, p)


def set_job(root: Path, pid: str, **fields) -> None:
    f = _job_file(root, pid)
    cur = json.loads(f.read_text()) if f.is_file() else {}
    _write_json(f, {**cur, **fields})


def episode(root: Path, pid: str) -> dict | None:
    f = book_dir(root) / "book.json"
    if not f.is_file():
        return None
    try:
        chapters = json.loads(f.read_text()).get("chapters", [])
    except ValueError:
        return None
    c = next((c for c in chapters if c.get("pid") == pid and "bytes" in c), None)
    return c if c and (book_dir(root) / c["file"]).is_file() else None


def status(root: Path, pid: str) -> dict:
    """{"state": "none" | "writing" | "speaking" | "done" | "error", "error"?, "episode"?}"""
    f = _job_file(root, pid)
    job = json.loads(f.read_text()) if f.is_file() else {}
    state = job.get("state", "none")
    if state in ("writing", "speaking") and time.time() - job.get("started", 0) > STALE:
        state, job["error"] = "error", "the job stopped without finishing"
    out: dict = {"state": state}
    if state == "error":
        out["error"] = job.get("error") or "failed"
    if (ep := episode(root, pid)):
        out["episode"] = {"n": ep["n"], "duration": ep.get("duration", 0), "bytes": ep["bytes"],
                          "generated": ep.get("generated")}
        if state == "none":
            out["state"] = "done"
    return out


def running(root: Path, pid: str) -> bool:
    return status(root, pid)["state"] in ("writing", "speaking")


def start(root: Path, pid: str, pdf: Path, title: str, *, python: str, claude_bin: str) -> None:
    """Spawn the job detached (survives a service restart); progress goes to paper_jobs/<pid>.json."""
    set_job(root, pid, state="writing", started=time.time(), error=None, title=title)
    log = (root / "paper_jobs" / f"{pid}.log").open("w")
    subprocess.Popen([python, str(Path(__file__).resolve()), "make", "--root", str(root), "--pid", pid,
                      "--pdf", str(pdf), "--title", title, "--claude", claude_bin],
                     stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
    log.close()


# ---------------------------------------------------------------- the job

def paper_text(pdf: Path) -> str:
    import pymupdf

    with pymupdf.open(str(pdf)) as doc:
        text = "\n".join(page.get_text() for page in doc)
    marks = list(REFS.finditer(text))
    if marks and marks[-1].start() > len(text) * 0.4:  # drop the reference list
        text = text[:marks[-1].start()]
    text = re.sub(r"[ \t]+", " ", re.sub(r"\n{3,}", "\n\n", text)).strip()
    if len(text) < 1500:
        raise RuntimeError("almost no text in the PDF (scanned?)")
    return text[:MAX_INPUT]


def clean_script(s: str) -> str:
    s = re.sub(r"^\s*#+\s*", "", s, flags=re.M)  # headings
    s = re.sub(r"^\s*([-*•]|\d+[.)])\s+", "", s, flags=re.M)  # list markers
    s = re.sub(r"\*\*|__|`", "", s)
    s = re.sub(r"\[(\d+(,\s*\d+)*)\]", "", s)  # leftover [12] citations
    return re.sub(r"\n{3,}", "\n\n", s).strip()


def write_script(title: str, text: str, claude_bin: str) -> str:
    r = subprocess.run([claude_bin, "-p", "--output-format", "text"], input=PROMPT.format(title=title, text=text),
                       capture_output=True, text=True, timeout=20 * 60)
    if r.returncode != 0 or len(r.stdout.strip()) < 500:
        raise RuntimeError(f"claude failed ({r.returncode}): {(r.stderr or r.stdout).strip()[-300:]}")
    return clean_script(r.stdout)


def add_episode(root: Path, pid: str, title: str, mp3_tmp: Path, script: str, dur: int) -> dict:
    """Move the finished mp3 into the book under a file lock (several jobs may finish at once)."""
    d = book_dir(root)
    d.mkdir(parents=True, exist_ok=True)
    with open(d / ".lock", "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        f = d / "book.json"
        meta = json.loads(f.read_text()) if f.is_file() else {
            "title": "Paper briefs", "lang": "en", "voice": VOICE,
            "added": datetime.now(timezone.utc).isoformat(timespec="seconds"), "chapters": [], "complete": True}
        old = next((c for c in meta["chapters"] if c.get("pid") == pid), None)
        n = old["n"] if old else max((c["n"] for c in meta["chapters"]), default=0) + 1
        c = {"n": n, "title": title[:200], "file": f"{n:03d}.mp3", "pid": pid, "duration": dur,
             "bytes": mp3_tmp.stat().st_size, "generated": datetime.now(timezone.utc).isoformat(timespec="seconds")}
        os.replace(mp3_tmp, d / c["file"])
        (d / f"{n:03d}.txt").write_text(script)
        meta["chapters"] = sorted([x for x in meta["chapters"] if x.get("pid") != pid] + [c], key=lambda x: x["n"])
        _write_json(f, meta)
    return c


def make(root: Path, pid: str, pdf: Path, title: str, claude_bin: str) -> None:
    from audiobook import duration, tts  # same directory; run with the audiobook venv

    try:
        set_job(root, pid, state="writing", started=time.time(), error=None)
        script = write_script(title, paper_text(pdf), claude_bin)
        set_job(root, pid, state="speaking", started=time.time())
        tmp = book_dir(root) / f".{pid}.mp3"
        tmp.parent.mkdir(parents=True, exist_ok=True)
        tts(script, VOICE, tmp)
        c = add_episode(root, pid, title, tmp, script, duration(tmp))
        set_job(root, pid, state="done", error=None)
        print(f"done: {c['file']} ({c['duration']} s)", flush=True)
    except Exception as e:
        set_job(root, pid, state="error", error=str(e)[:300])
        print(f"FAILED: {e}", flush=True)
        raise


def main(argv: list[str]) -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("make")
    m.add_argument("--root", type=Path, required=True)
    m.add_argument("--pid", required=True)
    m.add_argument("--pdf", type=Path, required=True)
    m.add_argument("--title", required=True)
    m.add_argument("--claude", default="claude")
    a = ap.parse_args(argv)
    make(a.root, a.pid, a.pdf, a.title, a.claude)


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    main(sys.argv[1:])
