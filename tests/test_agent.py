import asyncio
from backend.agent import build_command, build_prompt, run_agent


def collect(gen):
    async def go():
        return [e async for e in gen]
    return asyncio.run(go())


def test_build_command_new_and_resume():
    base = ["claude", "-p", "--output-format", "stream-json", "--verbose",
            "--permission-mode", "bypassPermissions"]
    assert build_command("claude") == base
    assert build_command("claude", "s1") == base + ["--resume", "s1"]


def test_build_prompt_with_context():
    assert build_prompt("hi") == "hi"
    out = build_prompt("handle this", {"panel": "log", "card": "Q1 text"})
    assert out.endswith("[Current panel: log]\n[Selected card]\nQ1 text\n\nhandle this")  # after the [Workspace] note, if any


def test_run_agent_streams_events(fake_claude, tmp_path):
    events = collect(run_agent(fake_claude, "hello", tmp_path))
    assert events[0] == {"kind": "session", "session_id": "sess-1"}
    assert {"kind": "text", "text": "echo: hello"} in events
    assert events[-1]["kind"] == "done"


def test_run_agent_resume_and_prompt_starting_with_dash(fake_claude, tmp_path):
    events = collect(run_agent(fake_claude, "--help me", tmp_path, session_id="old"))
    assert events[0]["session_id"] == "old"
    assert {"kind": "text", "text": "echo: --help me"} in events


def test_run_agent_nonzero_exit_reports_error(fake_claude, tmp_path):
    events = collect(run_agent(fake_claude, "FAIL", tmp_path))
    assert events[-1]["kind"] == "error"
    assert "boom" in events[-1]["message"]


# --- review fixes -----------------------------------------------------------
import time

from backend.agent import AgentRun


def test_missing_binary_yields_error(tmp_path):
    events = collect(run_agent(str(tmp_path / "no-such-claude"), "hi", tmp_path))
    assert len(events) == 1 and events[0]["kind"] == "error"


def test_timeout_kills_and_reports(fake_claude, tmp_path):
    t0 = time.monotonic()
    events = collect(run_agent(fake_claude, "SLEEP", tmp_path, timeout=1))
    assert time.monotonic() - t0 < 10
    assert events[-1]["kind"] == "error" and "timed out" in events[-1]["message"]


def test_oversized_line_yields_error(fake_claude, tmp_path):
    run = AgentRun(fake_claude, "BIGLINE", tmp_path, line_limit=64 * 1024)
    events = collect(run.events())
    assert events[-1]["kind"] == "error"
    assert run.proc.returncode is not None


def test_cancel_kills_run(fake_claude, tmp_path):
    async def go():
        run = AgentRun(fake_claude, "SLEEP", tmp_path)
        events = []
        async for e in run.events():
            events.append(e)
            if e["kind"] == "session":
                asyncio.get_running_loop().call_later(0.2, lambda: asyncio.ensure_future(run.cancel()))
        return run, events
    t0 = time.monotonic()
    run, events = asyncio.run(go())
    assert time.monotonic() - t0 < 10
    assert events[-1] == {"kind": "error", "message": "cancelled"}
    assert run.proc.returncode is not None


def test_stderr_is_bounded(tmp_path):
    script = tmp_path / "noisy"
    script.write_text("#!/usr/bin/env python3\nimport sys\nsys.stdin.read()\n"
                      "sys.stderr.write('e' * 100000 + 'TAIL')\nsys.exit(3)\n")
    script.chmod(0o755)
    run = AgentRun(str(script), "x", tmp_path)
    events = collect(run.events())
    assert "TAIL" in events[-1]["message"]
    assert len(run.stderr_tail) <= 8 * 1024


# --- review round 2 ---------------------------------------------------------
import os


def test_cancel_before_spawn_never_runs(fake_claude, tmp_path):
    async def go():
        run = AgentRun(fake_claude, "SLEEP", tmp_path)
        await run.cancel()
        return run, [e async for e in run.events()]
    t0 = time.monotonic()
    run, events = asyncio.run(go())
    assert time.monotonic() - t0 < 2
    assert events == [{"kind": "error", "message": "cancelled"}]
    assert run.proc is None


def test_grandchild_holding_stdout_does_not_hang(tmp_path):
    pidfile = tmp_path / "gc.pid"
    script = tmp_path / "gc.sh"
    script.write_text(
        "#!/bin/sh\ncat >/dev/null\n"
        f"sleep 300 & echo $! > {pidfile}\n"
        'echo \'{"type":"system","subtype":"init","session_id":"g"}\'\n'
        'echo \'{"type":"result","subtype":"success","is_error":false,"session_id":"g"}\'\n'
        "exit 0\n")
    script.chmod(0o755)
    t0 = time.monotonic()
    events = collect(AgentRun(str(script), "x", tmp_path, timeout=20).events())
    assert time.monotonic() - t0 < 8
    assert [e["kind"] for e in events] == ["session", "done"]
    pid = int(pidfile.read_text())
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.1)
    else:
        os.kill(pid, 9)
        raise AssertionError("grandchild survived")



