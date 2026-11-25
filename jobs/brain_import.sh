#!/bin/bash
# Daily (jobs/scheduler.py): Zotero web API -> Brain panel (backend/brain_import.py). Idempotent; never touches the
# owner's confirmations / notes / renames / answers.
set -uo pipefail
LOG="$HOME/Research/pipeline/brain_import.log"
cd "$HOME/research-platform"
set -a; [ -f "$HOME/.config/research-platform/env" ] && . "$HOME/.config/research-platform/env"; set +a
{ echo "[$(date '+%Y-%m-%d %H:%M:%S')] brain import"; .venv/bin/python -m backend.brain_import; } >> "$LOG" 2>&1
rc=$?
tail -2 "$LOG"
exit $rc
