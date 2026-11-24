import asyncio
import os
import signal
from collections.abc import AsyncIterator
from pathlib import Path

from .stream import parse_line


def build_command(claude_bin: str, session_id: str | None = None) -> list[str]:
    # Prompt goes through stdin, so a prompt starting with "-" is never parsed as a flag.
    cmd = [claude_bin, "-p", "--output-format", "stream-json", "--verbose",
           "--permission-mode", "bypassPermissions"]
    if session_id:
        cmd += ["--resume", session_id]
    return cmd


from .hints import GENERAL, PANEL_HINTS  # noqa: E402  (public build swaps hints.py)


IMAGE_MAX = 4
IMAGE_BYTES = 6 * 1024 * 1024
IMAGE_KEEP_DAYS = 7
_IMAGE_KINDS = {b"\x89PNG\r\n\x1a\n": "png", b"\xff\xd8\xff": "jpg", b"GIF87a": "gif", b"GIF89a": "gif"}


def _image_ext(data: bytes) -> str | None:
    for magic, ext in _IMAGE_KINDS.items():
        if data.startswith(magic):
            return ext
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def save_images(images: list[str], folder: Path) -> list[Path]:
    """Decode pasted images (data URLs or bare base64) into `folder` so the agent can open
    them with its Read tool. Raises ValueError for anything that is not a small PNG/JPEG/GIF/WebP.
    Files older than IMAGE_KEEP_DAYS are removed on the way."""
    import base64, binascii, time, uuid
    if len(images) > IMAGE_MAX:
        raise ValueError(f"at most {IMAGE_MAX} images per message")
    decoded = []
    for raw in images:
        b64 = raw.split(",", 1)[1] if raw.startswith("data:") else raw
        try:
            data = base64.b64decode(b64, validate=True)
        except (binascii.Error, ValueError):
            raise ValueError("image is not valid base64") from None
        if len(data) > IMAGE_BYTES:
            raise ValueError(f"image larger than {IMAGE_BYTES // (1024 * 1024)} MB")
        ext = _image_ext(data)
        if ext is None:
            raise ValueError("only PNG, JPEG, GIF or WebP images")
        decoded.append((data, ext))
    folder.mkdir(parents=True, exist_ok=True)
    cutoff = time.time() - IMAGE_KEEP_DAYS * 86400
    for old in folder.iterdir():
        try:
            if old.is_file() and old.stat().st_mtime < cutoff:
                old.unlink()
        except OSError:
            pass
    paths = []
    for data, ext in decoded:
        path = folder / f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}.{ext}"
        path.write_bytes(data)
        paths.append(path)
    return paths


def build_prompt(text: str, context: dict | None = None, images: list[Path] | None = None) -> str:
    if images:
        listed = "\n".join(f"- {p}" for p in images)
        text = (f"[the user pasted {len(images)} image(s); open each with the Read tool before answering]\n"
                f"{listed}\n\n{text}")
    if not context:
        return text
    parts = [f"[Workspace] {GENERAL}"] if GENERAL else []
    if context.get("panel"):
        parts.append(f"[Current panel: {context['panel']}]")
        if hint := PANEL_HINTS.get(context["panel"]):
            parts.append(f"[Panel note] {hint}")
    if context.get("card"):
        parts.append(f"[Selected card]\n{context['card']}")
    return "\n".join(parts) + "\n\n" + text if parts else text


STDERR_KEEP = 8 * 1024
LINE_LIMIT = 16 * 1024 * 1024
KILL_GRACE = 5.0
DRAIN_GRACE = 2.0  # after the leader exits, how long to keep reading stdout
POLL = 0.2

CANCELLED = {"kind": "error", "message": "cancelled"}


class AgentRun:
    """One `claude -p` subprocess. `events()` streams UI events and never raises for
    process-level failures (missing binary, crash, timeout, oversized output, cancel):
    those become a final {"kind": "error"} event. The process group is always killed.

    Leader exit is detected via `proc.returncode` (set as soon as the leader exits),
    not `proc.wait()`, which also waits for every pipe to close and would hang while
    a grandchild (e.g. `sleep 300 &` from a Bash tool) still holds stdout."""

    def __init__(self, claude_bin: str, prompt: str, cwd: Path,
                 session_id: str | None = None, timeout: float | None = None,
                 line_limit: int = LINE_LIMIT):
        self.cmd = build_command(claude_bin, session_id)
        self.prompt = prompt
        self.cwd = cwd
        self.timeout = timeout
        self.line_limit = line_limit
        self.proc: asyncio.subprocess.Process | None = None
        self.stderr_tail = b""
        self.cancelled = False

    async def _drain_stderr(self) -> None:
        assert self.proc and self.proc.stderr
        while chunk := await self.proc.stderr.read(4096):
            self.stderr_tail = (self.stderr_tail + chunk)[-STDERR_KEEP:]

    def _signal(self, sig: int) -> None:
        assert self.proc
        try:
            os.killpg(self.proc.pid, sig)  # start_new_session=True -> pgid == pid
        except (ProcessLookupError, PermissionError):
            pass

    async def _leader_exit(self, limit: float | None) -> bool:
        """Wait until the leader has exited (returncode set); False on timeout."""
        assert self.proc
        loop = asyncio.get_running_loop()
        end = None if limit is None else loop.time() + limit
        while self.proc.returncode is None:
            if end is not None and loop.time() >= end:
                return False
            await asyncio.sleep(POLL)
        return True

    async def kill(self) -> None:
        """SIGTERM the whole process group (always, even if the leader already exited, so
        orphaned grandchildren die), SIGKILL after a grace period. Bounded: never hangs."""
        if self.proc is None:
            return
        self._signal(signal.SIGTERM)
        if not await self._leader_exit(KILL_GRACE):
            self._signal(signal.SIGKILL)
            await self._leader_exit(KILL_GRACE)
        else:
            await asyncio.sleep(0)  # let SIGTERM land on grandchildren
            self._signal(signal.SIGKILL)

    async def cancel(self) -> None:
        self.cancelled = True
        await self.kill()

    async def events(self) -> AsyncIterator[dict]:
        stderr_task: asyncio.Task | None = None
        read: asyncio.Future | None = None
        try:
            if self.cancelled:  # cancelled before we ever started
                yield CANCELLED
                return
            try:
                self.proc = await asyncio.create_subprocess_exec(
                    *self.cmd, cwd=str(self.cwd), stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                    limit=self.line_limit, start_new_session=True)
            except OSError as exc:  # FileNotFoundError, PermissionError, ...
                yield {"kind": "error", "message": f"cannot start claude: {exc}"}
                return
            if self.cancelled:  # cancel() raced with the spawn
                await self.kill()
                yield CANCELLED
                return
            proc = self.proc
            assert proc.stdin and proc.stdout and proc.stderr
            stderr_task = asyncio.create_task(self._drain_stderr())
            try:
                proc.stdin.write(self.prompt.encode())
                await proc.stdin.drain()
                proc.stdin.close()
            except (BrokenPipeError, ConnectionResetError) as exc:
                await self.kill()
                yield {"kind": "error", "message": f"claude closed stdin: {exc}"}
                return
            loop = asyncio.get_running_loop()
            deadline = loop.time() + self.timeout if self.timeout else None
            exited_at: float | None = None
            while True:
                if read is None:
                    read = asyncio.ensure_future(proc.stdout.readline())
                now = loop.time()
                if exited_at is None and proc.returncode is not None:
                    exited_at = now
                if exited_at is not None and now - exited_at >= DRAIN_GRACE:
                    break  # leader gone; a grandchild is holding stdout open
                if exited_at is None and deadline is not None and now >= deadline:
                    await self.kill()
                    yield {"kind": "error", "message": f"agent timed out after {self.timeout:g}s"}
                    return
                done, _ = await asyncio.wait({read}, timeout=POLL)
                if not done:
                    continue
                try:
                    raw = read.result()
                except (ValueError, asyncio.LimitOverrunError) as exc:
                    read = None
                    await self.kill()
                    yield {"kind": "error", "message": f"claude output line too long: {exc}"}
                    return
                read = None
                if not raw:
                    break
                for event in parse_line(raw.decode("utf-8", "replace")):
                    yield event
            # stdout closed (or abandoned): wait for the leader within the remaining budget
            remaining = None if deadline is None else max(deadline - loop.time(), 0.0)
            if not await self._leader_exit(remaining):
                await self.kill()
                yield {"kind": "error", "message": f"agent timed out after {self.timeout:g}s"}
                return
            code = proc.returncode
            if self.cancelled:
                yield CANCELLED
            elif code != 0:
                await asyncio.wait({stderr_task}, timeout=1)
                tail = self.stderr_tail.decode("utf-8", "replace")
                yield {"kind": "error", "message": f"claude exited {code}: {tail[-500:]}"}
        finally:
            if read is not None and not read.done():
                read.cancel()
            if self.proc is not None:
                await self.kill()
            if stderr_task is not None and not stderr_task.done():
                stderr_task.cancel()


async def run_agent(claude_bin: str, prompt: str, cwd: Path, session_id: str | None = None,
                    timeout: float | None = None) -> AsyncIterator[dict]:
    async for event in AgentRun(claude_bin, prompt, cwd, session_id, timeout).events():
        yield event
