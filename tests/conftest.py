import os
import stat
import textwrap
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.journal import Journal
from backend.settings import Settings

FAKE_CLAUDE = textwrap.dedent('''\
    #!/usr/bin/env python3
    import json, sys, pathlib, time
    prompt = sys.stdin.read()
    args = sys.argv[1:]
    sid = args[args.index("--resume") + 1] if "--resume" in args else "sess-1"
    def emit(o): print(json.dumps(o), flush=True)
    emit({"type": "system", "subtype": "init", "session_id": sid})
    if "SLEEPWRITE" in prompt:
        time.sleep(1.0)
        pathlib.Path("note.md").write_text("agent wrote this\\n")
    elif "SLEEP" in prompt:
        time.sleep(30)
    elif "WRITE" in prompt:
        pathlib.Path("note.md").write_text("agent wrote this\\n")
    if "BIGLINE" in prompt:
        print("x" * 200_000, flush=True)
        emit({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "Write", "input": {"file_path": "note.md"}}]}})
    emit({"type": "assistant", "message": {"content": [{"type": "text", "text": "echo: " + prompt}]}})
    if "FAIL" in prompt:
        sys.stderr.write("boom\\n"); sys.exit(2)
    emit({"type": "result", "subtype": "success", "is_error": False, "session_id": sid, "result": "ok"})
''')


@pytest.fixture
def fake_claude(tmp_path: Path) -> str:
    p = tmp_path / "fake_claude"
    p.write_text(FAKE_CLAUDE)
    p.chmod(p.stat().st_mode | stat.S_IEXEC)
    return str(p)


@pytest.fixture
def settings(tmp_path: Path, fake_claude: str) -> Settings:
    root = tmp_path / "Research"
    root.mkdir()
    (root / "research_tasks.md").write_text("# tasks\n")
    (root / "projects.yaml").write_text("projects:\n  - {name: Alpha, code: S}\n  - {name: Beta, code: V}\n")
    s = Settings(research_root=root, git_dir=tmp_path / "research-git", claude_bin=fake_claude)
    Journal(s.git_dir, s.research_root).ensure_repo()  # like the server: baseline already done
    return s


@pytest.fixture
def client(settings: Settings) -> TestClient:
    return TestClient(create_app(settings))


