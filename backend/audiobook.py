"""PDF books -> chapter mp3s (Edge TTS) -> one private podcast feed.

Runs on the server. Layout under <root> (default ~/audiobooks):
  inbox/*.pdf                      books waiting to be converted (copied here by scp)
  library/<slug>/book.json         {title, lang, voice, added, source, chapters: [...]}
  library/<slug>/NN.mp3            one file per chapter (or chapter part)
  done/*.pdf                       converted sources

CLI (use the venv that has edge-tts + pymupdf, i.e. ~/audiobooks/.venv):
  python backend/audiobook.py run                 # convert everything in inbox/, resumable
  python backend/audiobook.py plan <pdf>          # dry run: print the chapters it would make
  python backend/audiobook.py list                # books + progress

The feed side (feed_xml, library listing) is stdlib-only; app.py serves it at /podcast/<token>/.
"""
from __future__ import annotations

import json
import re
import secrets
import subprocess
import sys
import time
from datetime import datetime, timezone
from email.utils import format_datetime
from pathlib import Path
from urllib.parse import quote
from xml.sax.saxutils import escape

VOICES = {"zh": "zh-CN-XiaoxiaoNeural", "en": "en-US-AvaNeural"}
# Max characters per episode (~25-30 min of speech).
MAX_CHARS = {"zh": 8000, "en": 24000}
MIN_CHARS = 300  # smaller TOC sections are merged into the next one
SKIP_TITLES = re.compile(
    r"^\s*(contents|table of contents|index|copyright|bibliography|references|works cited|"
    r"also by|about the publisher|目录|目\s*录|图形目录|图表目录|索引|版权|版权信息|参考文献|参考书目|附录.*|appendix.*|notes)\s*$", re.I)
CHAPTER_HEAD = re.compile(r"^\s*(第\s*([一二三四五六七八九十百零〇\d]+)\s*[章篇]|chapter\s+(\d+)\b)", re.I)
BACK_HEAD = re.compile(r"^\s*(附\s*录\s*[A-Za-z一二三四五六\d]?|参考文献|索\s*引|appendix\s*[A-Z\d]?|references|bibliography|index)\b", re.I)
PREFACE = re.compile(r"译者序|译\s*序|前\s*言|序\s*言|\bpreface\b|\bforeword\b", re.I)
FOOTNOTE = re.compile(r"^\s*[①-⑳]")
CN_DIGITS = {c: i for i, c in enumerate("零一二三四五六七八九")} | {"〇": 0}


def chapter_number(s: str) -> int:
    if s.isdigit():
        return int(s)
    total, cur = 0, 0
    for c in s:
        if c == "百":
            total += (cur or 1) * 100; cur = 0
        elif c == "十":
            total += (cur or 1) * 10; cur = 0
        else:
            cur = CN_DIGITS.get(c, 0)
    return total + cur
CJK = re.compile(r"[㐀-鿿豈-﫿]")
BOOK_FILES = {".pdf", ".epub", ".mobi"}
SAFE_FILE = re.compile(r"^\d{2,3}\.mp3$")


# ---------------------------------------------------------------- text cleanup (pure)

def detect_lang(text: str) -> str:
    sample = text[:200_000]
    letters = sum(c.isalpha() for c in sample) or 1
    return "zh" if len(CJK.findall(sample)) / letters > 0.3 else "en"


def _norm(line: str) -> str:
    return re.sub(r"\d+", "#", line.strip().lower())


def strip_running_heads(pages: list[str]) -> list[str]:
    """Drop header/footer lines that repeat across pages (after digits -> #) and bare page numbers."""
    if not pages:
        return pages
    counts: dict[str, int] = {}
    for p in pages:
        lines = [l for l in p.splitlines() if l.strip()]
        for l in set(lines[:2] + lines[-2:]):
            counts[_norm(l)] = counts.get(_norm(l), 0) + 1
    limit = max(3, len(pages) * 0.015)
    repeated = {k for k, v in counts.items() if v >= limit}
    out = []
    for p in pages:
        lines = [l for l in p.splitlines() if l.strip()]
        n = len(lines)
        keep = []
        for i, l in enumerate(lines):
            edge = i < 2 or i >= n - 2
            if FOOTNOTE.match(l):
                continue
            if edge and (_norm(l) in repeated or re.fullmatch(r"[\divxlcIVXLC\-–— ]{1,8}", l.strip())):
                continue
            keep.append(l)
        out.append("\n".join(keep))
    return out


def join_lines(text: str) -> str:
    """Re-flow PDF line breaks into sentences for TTS."""
    text = text.replace("­", "")
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)                      # English hyphenation
    text = re.sub(f"({CJK.pattern})\\s*\\n\\s*(?={CJK.pattern})", r"\1", text)  # CJK wraps
    text = re.sub(r"([^\n.!?。！？:：;；\"”」』)）])\n(?=\S)", r"\1 ", text)    # mid-sentence wraps
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{2,}", "\n", text)
    return text.strip()


def split_long(text: str, max_chars: int) -> list[str]:
    """Split at line/sentence boundaries into roughly equal parts of <= max_chars."""
    if len(text) <= max_chars:
        return [text]
    n = -(-len(text) // max_chars)
    target = len(text) / n
    parts, cur = [], ""
    for seg in re.split(r"(?<=[\n。！？.!?])", text):
        if cur and len(cur) + len(seg) > target and len(parts) < n - 1:
            parts.append(cur.strip())
            cur = ""
        cur += seg
    if cur.strip():
        parts.append(cur.strip())
    return parts


def plan_episodes(sections: list[tuple[str, str]], lang: str) -> list[dict]:
    """[(title, text)] -> [{title, text}] : drop skip-titles, merge tiny sections, split long ones."""
    kept = [(t, s) for t, s in sections if not SKIP_TITLES.match(t or "")]
    merged: list[list[str]] = []
    carry_title, carry = None, ""
    for title, text in kept:
        text = text.strip()
        if len(carry) + len(text) < MIN_CHARS:
            carry_title = carry_title or title
            carry = (carry + "\n" + text).strip()
            continue
        merged.append([carry_title or title, (carry + "\n" + text).strip()])
        carry_title, carry = None, ""
    if carry:
        if merged:
            merged[-1][1] += "\n" + carry
        else:
            merged.append([carry_title or "", carry])
    eps = []
    for title, text in merged:
        parts = split_long(text, MAX_CHARS[lang])
        for i, p in enumerate(parts, 1):
            if not title:
                t = f"第 {len(eps) + 1} 部分" if lang == "zh" else f"Part {len(eps) + 1}"
            else:
                t = title if len(parts) == 1 else f"{title} ({i}/{len(parts)})"
            eps.append({"title": t, "text": p})
    return eps


def slugify(name: str) -> str:
    s = re.sub(r"[^\w㐀-鿿]+", "-", name).strip("-").lower()
    return s[:60] or "book"


# ---------------------------------------------------------------- PDF -> sections (needs pymupdf)

def _ocr_page(args: tuple[str, int]) -> str:
    import pymupdf
    from rapidocr_onnxruntime import RapidOCR

    global _OCR
    if "_OCR" not in globals():
        import os
        os.nice(10)  # the server also hosts the study sites
        _OCR = RapidOCR(intra_op_num_threads=2, inter_op_num_threads=1)
    path, i = args
    png = pymupdf.open(path)[i].get_pixmap(dpi=200).tobytes("png")
    res, _ = _OCR(png)
    return "\n".join(r[1] for r in (res or []))


# Live progress for the My books panel: <root>/status.json {zotero_key, title, stage, done, total}.
STATUS: dict = {}


def report(stage: str, done: int, total: int) -> None:
    if not STATUS.get("_file"):
        return
    f = Path(STATUS["_file"])
    data = {k: v for k, v in STATUS.items() if not k.startswith("_")} | {
        "stage": stage, "done": done, "total": total, "updated": int(time.time())}
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False))
    tmp.replace(f)


def load_status(root: Path) -> dict:
    try:
        return json.loads((root / "status.json").read_text())
    except (OSError, ValueError):
        return {}


def ocr_pages(pdf: Path, n: int) -> list[str]:
    """Scanned PDF -> page texts (RapidOCR, parallel), cached next to the PDF."""
    cache = pdf.with_suffix(".ocr.json")
    if cache.is_file():
        return json.loads(cache.read_text())
    from concurrent.futures import ProcessPoolExecutor
    print(f"OCR {n} pages ...", flush=True)
    with ProcessPoolExecutor(max_workers=10) as ex:
        pages = []
        for p in ex.map(_ocr_page, [(str(pdf), i) for i in range(n)], chunksize=4):
            pages.append(p)
            if len(pages) % 10 == 0 or len(pages) == n:
                report("ocr", len(pages), n)
    cache.write_text(json.dumps(pages, ensure_ascii=False))
    return pages


def heading_marks(raw_pages: list[str]) -> list[tuple[int, str]]:
    """No TOC: first page where each new '第N章 / Chapter N' heading appears at the top of a page."""
    marks, last, back = [], 0, set()
    for i, p in enumerate(raw_pages, 1):
        lines = [l.strip() for l in p.splitlines() if l.strip()]
        if sum(1 for l in lines if CHAPTER_HEAD.match(l)) >= 3:
            continue  # a table-of-contents page
        for line in lines[:3]:
            m = CHAPTER_HEAD.match(line)
            if m:
                n = chapter_number(m.group(2) or m.group(3))
                if n > last:  # chapter numbers only go up
                    last = n
                    marks.append((i, line))
                break
            b = BACK_HEAD.match(line)
            if b and last:
                key = re.sub(r"\s", "", b.group(1)).lower()
                if key not in back:
                    back.add(key)
                    marks.append((i, re.sub(r"\s", "", b.group(1))))
                break
    return marks


def pdf_author(pdf: Path) -> str:
    """PDF metadata author, else the '(…作者著…)' / '(Author)' part of a z-library style filename."""
    import pymupdf as fitz

    a = ((fitz.open(pdf).metadata or {}).get("author") or "").strip()
    if a and a.lower() not in {"unknown", "administrator", "user"}:
        return a
    m = re.search(r"\(([^()]+?)(?:著|编著|主编)", pdf.stem)
    return m.group(1).strip() if m else ""


def read_pdf(pdf: Path) -> tuple[str, list[tuple[str, str]]]:
    import pymupdf as fitz

    doc = fitz.open(pdf)
    raw = [pg.get_text("text") for pg in doc]
    if sum(len(p.strip()) for p in raw) < 100 * max(1, len(raw)) * 0.2:
        raw = ocr_pages(pdf, len(raw))  # scanned book
    pages = strip_running_heads(raw)
    title = (doc.metadata or {}).get("title", "").strip()
    if not title or title.lower() in {"untitled", "microsoft word"} or title.lower().endswith((".doc", ".docx", ".pdf")):
        title = pdf.stem
    toc = [(lvl, t.strip(), max(1, p)) for lvl, t, p in doc.get_toc() if p > 0]
    level = 1
    if sum(1 for l, *_ in toc if l == 1) < 3 and sum(1 for l, *_ in toc if l == 2) >= 3:
        level = 2
    marks = sorted({(p, t) for l, t, p in toc if l == level}, key=lambda x: x[0])
    if len(marks) < 2:
        marks = heading_marks(raw)
    if len(marks) < 2:  # no usable TOC: one section, split by length later
        return title, [("", join_lines("\n".join(pages)))]
    sections = []
    if marks[0][0] > 1:
        sections.append(("", join_lines("\n".join(pages[: marks[0][0] - 1]))))
    for i, (p, t) in enumerate(marks):
        end = marks[i + 1][0] - 1 if i + 1 < len(marks) else len(pages)
        sections.append((t, join_lines("\n".join(pages[p - 1: max(end, p)]))))
    # front matter before chapter 1 is cover/copyright + preface: keep only from the preface on
    if sections and sections[0][0] == "":
        m = PREFACE.search(sections[0][1])
        if m:
            sections[0] = ("序言" if CJK.search(m.group(0)) else "Preface", sections[0][1][m.start():])
        elif len(sections[0][1]) < 3000:
            sections = sections[1:]
    return title, sections


# ---------------------------------------------------------------- TTS

def tts(text: str, voice: str, out: Path, rate: str = "+0%") -> None:
    import asyncio

    import edge_tts

    tmp = out.with_suffix(".part")
    for attempt in range(4):
        try:
            asyncio.run(edge_tts.Communicate(text, voice, rate=rate).save(str(tmp)))
            tmp.rename(out)
            return
        except Exception as e:  # network hiccups / throttling
            print(f"  tts retry {attempt + 1}: {e}", flush=True)
            time.sleep(10 * (attempt + 1))
    raise RuntimeError(f"TTS failed for {out.name}")


def duration(mp3: Path) -> int:
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(mp3)],
                       capture_output=True, text=True)
    try:
        return int(float(r.stdout.strip()))
    except ValueError:
        return 0


# ---------------------------------------------------------------- library

def load_books(root: Path) -> list[dict]:
    books = []
    lib = root / "library"
    if not lib.is_dir():
        return books
    for d in sorted(lib.iterdir()):
        f = d / "book.json"
        if f.is_file():
            try:
                b = json.loads(f.read_text())
            except ValueError:
                continue
            b["slug"] = d.name
            books.append(b)
    return sorted(books, key=lambda b: b.get("added", ""))


def sidecar(pdf: Path) -> dict:
    """inbox/<book>.meta.json written by the Mac (tools/zotero_books_sync.py): {title, author, zotero_key}."""
    try:
        return json.loads(pdf.with_suffix(".meta.json").read_text())
    except (OSError, ValueError):
        return {}


def convert(pdf: Path, root: Path, voice: str | None = None, rate: str = "+0%") -> Path:
    side = sidecar(pdf)
    STATUS.clear()
    STATUS.update({"_file": str(root / "status.json"), "zotero_key": side.get("zotero_key", ""),
                   "title": side.get("title") or pdf.stem})
    report("reading", 0, 0)
    title, sections = read_pdf(pdf)
    title = side.get("title") or title
    lang = detect_lang("".join(s for _, s in sections))
    eps = plan_episodes(sections, lang)
    lib = root / "library"
    slug = slugify(title)
    d = lib / slug
    meta_f = d / "book.json"
    if meta_f.is_file():
        meta = json.loads(meta_f.read_text())
    else:
        d.mkdir(parents=True, exist_ok=True)
        meta = {"title": title, "author": side.get("author") or pdf_author(pdf), "lang": lang, "voice": voice or VOICES[lang], "rate": rate, "source": pdf.name, "zotero_key": side.get("zotero_key", ""),
                "added": datetime.now(timezone.utc).isoformat(timespec="seconds"), "chapters": []}
    meta["chapters"] = [{"n": i, "title": e["title"] or f"Part {i}", "file": f"{i:03d}.mp3", "chars": len(e["text"])}
                        | next((c for c in meta["chapters"] if c.get("n") == i and c.get("chars") == len(e["text"])), {})
                        for i, e in enumerate(eps, 1)]
    meta_f.write_text(json.dumps(meta, ensure_ascii=False, indent=1))
    print(f"{title}: {lang}, {len(eps)} episodes, {sum(len(e['text']) for e in eps)} chars", flush=True)
    for e, c in zip(eps, meta["chapters"]):
        mp3 = d / c["file"]
        if not mp3.is_file():
            print(f"  [{c['n']}/{len(eps)}] {c['title'][:50]}", flush=True)
            report("tts", c["n"] - 1, len(eps))
            tts(e["text"], meta["voice"], mp3, meta.get("rate", rate))
        c["duration"], c["bytes"] = duration(mp3), mp3.stat().st_size
        meta_f.write_text(json.dumps(meta, ensure_ascii=False, indent=1))
    meta["complete"] = True
    meta_f.write_text(json.dumps(meta, ensure_ascii=False, indent=1))
    return d


def _notify(msg: str) -> None:
    n = Path.home() / "Research/tools/notify.sh"
    if n.is_file():
        subprocess.run(["bash", str(n), msg], capture_output=True)


def run_inbox(root: Path) -> None:
    lock = root / ".lock"
    if lock.exists() and time.time() - lock.stat().st_mtime < 6 * 3600:
        print("already running", flush=True)
        return
    lock.touch()
    try:
        (root / "done").mkdir(parents=True, exist_ok=True)
        books = [f for f in sorted((root / "inbox").iterdir()) if f.suffix.lower() in BOOK_FILES]
        for pdf in books:
            lock.touch()
            try:
                d = convert(pdf, root)
                pdf.rename(root / "done" / pdf.name)
                for extra in (pdf.with_suffix(".meta.json"), pdf.with_suffix(".ocr.json")):
                    if extra.exists():
                        extra.rename(root / "done" / extra.name)
                b = json.loads((d / "book.json").read_text())
                hours = sum(c.get("duration", 0) for c in b["chapters"]) / 3600
                _notify(f"Audiobook ready: {b['title']} ({len(b['chapters'])} episodes, {hours:.1f} h)")
            except Exception as e:
                print(f"FAILED {pdf.name}: {e}", flush=True)
                _notify(f"Audiobook conversion failed: {pdf.name}: {e}")
    finally:
        STATUS.clear()
        (root / "status.json").unlink(missing_ok=True)
        lock.unlink(missing_ok=True)


# ---------------------------------------------------------------- feed (stdlib only)

# Two feeds, each with its own token: personal reading stays private, research can be shared.
FEEDS = {"books": ("the user's Audiobooks", "Private audiobooks"),
         "research": ("the user's Research Briefs", "Audio briefs of research papers")}


def feed_of(book: dict) -> str:
    """book.json "feed" wins; the Reading panel's paper briefs (library/papers) are research; else books."""
    f = book.get("feed")
    if f in FEEDS:
        return f
    return "research" if book.get("slug") == "papers" else "books"


def feed_xml(books: list[dict], base: str, feed: str | None = None, slug: str | None = None) -> str:
    """One podcast per feed (or, with slug, per book); each chapter is an episode.
    base = https://host/podcast/<token>"""
    if feed is not None:
        books = [b for b in books if feed_of(b) == feed]
    title, desc = FEEDS[feed or "books"]
    author = ""
    if slug is not None:
        books = [b for b in books if b["slug"] == slug]
        if books:
            title, author = books[0]["title"], books[0].get("author", "")
            desc = season_name(books[0])
    items = []
    for season, b in enumerate(books, 1):
        added = datetime.fromisoformat(b["added"])
        for c in b["chapters"]:
            if "bytes" not in c:  # not generated yet
                continue
            pub = format_datetime(added.replace(microsecond=0).astimezone(timezone.utc)
                                  + _minutes(c["n"]), usegmt=True)
            url = f"{base}/{quote(b['slug'])}/{c['file']}"
            d = c.get("duration", 0)
            items.append(
                "<item>"
                f"<title>{escape(b['title'])} · {c['n']:02d} {escape(c['title'])}</title>"
                f"<guid isPermaLink=\"false\">{escape(b['slug'])}/{c['file']}</guid>"
                f"<pubDate>{pub}</pubDate>"
                f"<enclosure url=\"{escape(url)}\" length=\"{c['bytes']}\" type=\"audio/mpeg\"/>"
                f"<itunes:duration>{d // 3600:d}:{d % 3600 // 60:02d}:{d % 60:02d}</itunes:duration>"
                f"<itunes:season>{season}</itunes:season><itunes:episode>{c['n']}</itunes:episode>"
                f"<podcast:season name=\"{escape(season_name(b))}\">{season}</podcast:season>"
                f"<podcast:episode>{c['n']}</podcast:episode>"
                + (f"<itunes:author>{escape(b['author'])}</itunes:author>" if b.get("author") else "") +
                f"<description>{escape(season_name(b))}</description>"
                "</item>")
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"'
            ' xmlns:podcast="https://podcastindex.org/namespace/1.0">'
            f"<channel><title>{escape(title)}</title><link>https://research.example.com</link>"
            f"<description>{escape(desc)}</description><language>en</language>"
            + (f"<itunes:author>{escape(author)}</itunes:author>" if author else "") +
            "<itunes:type>serial</itunes:type><itunes:block>Yes</itunes:block>"
            + "".join(items) + "</channel></rss>")


def season_name(b: dict) -> str:
    """Season = one book: '书名 · 作者' (podcast:season name; Apple Podcasts ignores it, others show it)."""
    return f"{b['title']} · {b['author']}" if b.get("author") else b["title"]


def overview(root: Path, books_token: Path, host: str) -> dict:
    """For the Audiobooks panel (owner only: contains the secret feed URLs)."""
    tokens = {f: read_token(p) for f, p in token_files(books_token).items()}
    feeds = {f: f"{host}/podcast/{t}/feed.xml" if t else None for f, t in tokens.items()}
    out = []
    for b in load_books(root):
        feed = feed_of(b)
        t = tokens.get(feed)
        ready = [c for c in b["chapters"] if "bytes" in c]
        out.append({
            "slug": b["slug"], "title": b["title"], "author": b.get("author", ""), "feed": feed,
            "lang": b.get("lang", ""), "added": b.get("added", ""), "episodes": len(b["chapters"]),
            "ready": len(ready), "hours": round(sum(c.get("duration", 0) for c in ready) / 3600, 1),
            "complete": bool(b.get("complete")) or len(ready) == len(b["chapters"]),
            "feed_url": f"{host}/podcast/{t}/book/{quote(b['slug'])}.xml" if t else None,
            "zotero_key": b.get("zotero_key", ""),
            "chapters": [{"n": c["n"], "title": c["title"], "file": c["file"], "duration": c.get("duration", 0),
                          "ready": "bytes" in c} for c in b["chapters"]],
        })
    out.sort(key=lambda x: x["added"], reverse=True)
    return {"feeds": feeds, "books": out}


def queued(root: Path) -> list[dict]:
    """Books waiting/being converted in inbox/: [{title, zotero_key}]."""
    inbox = root / "inbox"
    if not inbox.is_dir():
        return []
    return [{"title": sidecar(f).get("title") or f.stem, "zotero_key": sidecar(f).get("zotero_key", "")}
            for f in sorted(inbox.iterdir()) if f.suffix.lower() in BOOK_FILES]


def load_progress(root: Path) -> dict:
    """{slug: {"file": "003.mp3", "pos": 123.4, "updated": iso}} - where in-site listening stopped."""
    try:
        return json.loads((root / "progress.json").read_text())
    except (OSError, ValueError):
        return {}


def save_progress(root: Path, slug: str, file: str, pos: float) -> None:
    if not SAFE_FILE.match(file) or chapter_file(root, slug, file) is None:
        raise ValueError("unknown episode")
    prog = load_progress(root)
    prog[slug] = {"file": file, "pos": round(max(0.0, pos), 1),
                  "updated": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    tmp = root / "progress.json.tmp"
    tmp.write_text(json.dumps(prog, ensure_ascii=False, indent=1))
    tmp.replace(root / "progress.json")


def _minutes(n: int):
    from datetime import timedelta
    return timedelta(minutes=n)


def chapter_file(root: Path, slug: str, name: str) -> Path | None:
    if not SAFE_FILE.match(name) or not re.fullmatch(r"[\w\-㐀-鿿]+", slug):
        return None
    f = root / "library" / slug / name
    return f if f.is_file() else None


def read_token(path: Path) -> str | None:
    try:
        t = path.read_text().strip()
    except OSError:
        return None
    return t if len(t) >= 20 else None


def token_ok(expected: str | None, given: str) -> bool:
    return bool(expected) and secrets.compare_digest(expected, given)


def token_files(books_token: Path) -> dict[str, Path]:
    """feed -> its token file: podcast_token (books) and podcast_token_research next to it."""
    return {"books": books_token, "research": books_token.with_name(books_token.name + "_research")}


def feed_for_token(books_token: Path, given: str) -> str | None:
    for feed, f in token_files(books_token).items():
        if token_ok(read_token(f), given):
            return feed
    return None


def book_feed(root: Path, slug: str) -> str | None:
    f = root / "library" / slug / "book.json"
    try:
        b = json.loads(f.read_text())
    except (OSError, ValueError):
        return None
    b["slug"] = slug
    return feed_of(b)


if __name__ == "__main__":
    root = Path.home() / "audiobooks"
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    if cmd == "run":
        run_inbox(root)
    elif cmd == "plan":
        t, secs = read_pdf(Path(sys.argv[2]))
        lang = detect_lang("".join(s for _, s in secs))
        eps = plan_episodes(secs, lang)
        print(f"{t} [{lang}] {len(eps)} episodes")
        for i, e in enumerate(eps, 1):
            print(f"{i:3d}  {len(e['text']):6d}  {e['title'][:60]}  | {e['text'][:60]!r}")
    elif cmd == "list":
        for b in load_books(root):
            done = sum(1 for c in b["chapters"] if "bytes" in c)
            h = sum(c.get("duration", 0) for c in b["chapters"]) / 3600
            print(f"{b['title']}: {done}/{len(b['chapters'])} episodes, {h:.1f} h")
    else:
        sys.exit(__doc__)
