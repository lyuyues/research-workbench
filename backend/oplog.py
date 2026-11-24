"""Operations log: an append-only JSONL of important actions, shown in the System log panel.

Actors: "agent" (platform agent runs), "user" (undo/cancel from the web UI), "system"
(service start), "claude-mac" (deploys/restarts/syncs done from the user's Mac via deploy/log.sh).
The file lives outside the Research tree (not synced, not journaled).
"""
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

MAX_DETAIL = 2000


class OpLog:
    def __init__(self, path: Path):
        self.path = Path(path)
        self._lock = threading.Lock()

    def append(self, actor: str, action: str, detail: str | None = None, **extra) -> None:
        rec = {"ts": int(time.time() * 1000), "actor": actor, "action": action}
        if detail:
            rec["detail"] = detail[:MAX_DETAIL]
        rec.update({k: v for k, v in extra.items() if v not in (None, [], "")})
        line = json.dumps(rec, ensure_ascii=False) + "\n"
        try:
            with self._lock:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
                with os.fdopen(fd, "a", encoding="utf-8") as f:
                    f.write(line)
        except OSError:
            pass  # logging must never break the app

    def read(self, limit: int = 300) -> list[dict]:
        """Newest first. Skips malformed lines."""
        try:
            with open(self.path, "rb") as f:
                f.seek(0, os.SEEK_END)
                size = f.tell()
                f.seek(max(0, size - 2_000_000))  # the tail is plenty
                lines = f.read().decode("utf-8", "replace").splitlines()
        except FileNotFoundError:
            return []
        out = []
        for ln in reversed(lines):
            try:
                rec = json.loads(ln)
            except ValueError:
                continue
            if isinstance(rec, dict) and "ts" in rec:
                out.append(rec)
            if len(out) >= limit:
                break
        return out
