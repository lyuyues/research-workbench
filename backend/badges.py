"""Sidebar badges: only things that need the user to act (not "something new to read").

  today        Claude's daily note is written (daily_check job) and the user hasn't opened Today since, plus
               ⚠️ questions in their files with no "→ the user:" reply yet (shown in Today as "Questions for you")
  meetings     meeting recaps still marked draft (waiting for review), last 30 days
  internships  new leads from the weekly search since Internships was last opened; Google sign-in expiring/expired
  automation   server jobs whose last run failed

"Seen" times (Today, Internships) live in <state>/seen.json, shared by all their devices.
"""
from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path

DRAFT = re.compile(r"^\s*<!-- status: draft")
SEEN_PANELS = ("today", "internships")


def _json(p: Path) -> dict:
    try:
        d = json.loads(p.read_text())
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


class Badges:
    def __init__(self, research_root: Path, state_dir: Path):
        self.root = Path(research_root)
        self.state = Path(state_dir)
        self.seen_path = self.state / "seen.json"

    def seen(self) -> dict:
        return _json(self.seen_path)

    def mark_seen(self, panel: str, now_ms: int | None = None) -> None:
        if panel not in SEEN_PANELS:
            raise ValueError("unknown panel")
        s = self.seen()
        s[panel] = now_ms or int(time.time() * 1000)
        self.state.mkdir(parents=True, exist_ok=True)
        tmp = self.seen_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(s))
        os.replace(tmp, self.seen_path)

    def recap_drafts(self, now: float | None = None) -> list[str]:
        now = now or time.time()
        out = []
        for kind in ("advisor", "group"):
            for f in sorted((self.root / "meetings" / kind).glob("*_recap.md")):
                try:
                    if now - f.stat().st_mtime > 30 * 86400:
                        continue
                    if DRAFT.match(f.read_text(encoding="utf-8")[:200]):
                        out.append(f"{kind} {f.name[:10]}")
                except OSError:
                    pass
        return out

    def failed_jobs(self) -> list[str]:
        out = []
        for f in sorted((self.state / "jobs").glob("*.json")):
            st = _json(f)
            if st.get("rc") not in (None, 0) and not st.get("running"):
                out.append(f.stem)
        return out

    def compute(self, pending_annotations: int, leads: list[dict], leads_updated: int, google: dict,
                now_ms: int | None = None) -> dict[str, dict]:
        now_ms = now_ms or int(time.time() * 1000)
        seen = self.seen()
        out: dict[str, dict] = {}
        daily = _json(self.state / "jobs" / "daily_check.json").get("last_ok") or 0
        today_n, today_t = 0, []
        if daily and daily > seen.get("today", 0):
            today_n, today_t = 1, ["Today's note from Claude is ready"]
        if pending_annotations:  # Annotations live in Today now ("Questions for you")
            today_n += pending_annotations
            today_t.append(f"{pending_annotations} question(s) in your documents waiting for an answer")
        if today_n:
            out["today"] = {"count": today_n, "title": "; ".join(today_t)}
        drafts = self.recap_drafts(now_ms / 1000)
        if drafts:
            out["meetings"] = {"count": len(drafts), "title": "Recap to review: " + ", ".join(drafts)}
        notes = []
        n_new = sum(1 for ld in leads if ld.get("status") == "new") if (leads_updated or 0) > seen.get("internships", 0) else 0
        if n_new:
            notes.append(f"{n_new} new lead(s) from the weekly search")
        sign_in = False
        if google.get("configured"):
            exp = (google.get("expires_at") or 0) * 1000
            if google.get("error"):
                notes.append("Google sign-in expired: run deploy/google_login.py")
                sign_in = True
            elif exp and exp - now_ms < 86_400_000:
                notes.append("Google sign-in expires within a day: run deploy/google_login.py")
                sign_in = True
        if notes:
            out["internships"] = {"count": n_new + int(sign_in), "title": "; ".join(notes)}
        failed = self.failed_jobs()
        if failed:
            out["automation"] = {"count": len(failed), "title": "Failed: " + ", ".join(failed), "alert": True}
        return out
