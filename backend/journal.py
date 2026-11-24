import re
import subprocess
import time
from pathlib import Path

# Keep the journal small: text only. Media/binaries/office files are protected by Nextcloud
# versions instead. Nextcloud temp/lock/conflict files are excluded so concurrent sync writes
# don't race the snapshot.
EXCLUDES = [
    # media
    "*.mp4", "*.mov", "*.webm", "*.mkv", "*.avi", "*.wav", "*.mp3", "*.m4a", "*.aac",
    "*.ogg", "*.flac",
    # images
    "*.png", "*.jpg", "*.jpeg", "*.gif", "*.heic", "*.webp", "*.svg", "*.tif", "*.tiff",
    "*.psd",
    # documents / office
    "*.pdf", "*.pptx", "*.docx", "*.xlsx", "*.key",
    # archives / data / models
    "*.zip", "*.gz", "*.tar", "*.7z", "*.pt", "*.npy", "*.pkl", "*.h5", "*.bin",
    "*.safetensors", "*.onnx", "*.sqlite", "*.db",
    # Reading panel state written by the web UI / Mac bridge outside agent runs (Nextcloud keeps versions)
    "reading/annotations/", "reading/library.json", "reading/zotero_*.json", "internships/applications.json", "internships/leads_state.json",
    "trends/saved.json",
    # tooling dirs
    "__pycache__/", "node_modules/", ".venv/", "Library/",
    # OS / Nextcloud sync noise
    ".DS_Store", "*.lnk", "*.nextcloud", "*conflicted copy*", ".sync_*",
    ".nextcloudsync.log", ".owncloudsync.log", "*.part", "*.~*", ".~lock.*#",
]
CONFIG = [
    "-c", "user.name=research-platform", "-c", "user.email=research-platform@localhost",
    # print non-ASCII paths verbatim (Research has 184 such paths)
    "-c", "core.quotePath=false",
    # nested repos (overleaf, web-demo, ...) have their own git; never treat them as changes
    "-c", "diff.ignoreSubmodules=all",
]
SHA_RE = re.compile(r"^[0-9a-f]{7,40}$")
STALE_LOCK_SECONDS = 10 * 60


class UndoRejected(ValueError):
    """The requested commit is not something we are willing to revert."""


class UndoConflict(RuntimeError):
    """The revert could not be applied cleanly (later edits touch the same lines)."""


class JournalUnavailable(RuntimeError):
    """The journal itself failed (e.g. git could not snapshot); retry later."""


class Journal:
    """Git history of the Research folder, with the git dir kept outside the synced tree.

    Known limitation (Phase 1): an agent snapshot captures every change in the tree since the
    pre-agent snapshot, including Nextcloud sync writes that land while the agent is running.
    """

    def __init__(self, git_dir: Path, work_tree: Path):
        self.git_dir = git_dir
        self.work_tree = work_tree

    def _run(self, *args: str, check: bool = True) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["git", "--literal-pathspecs", *CONFIG, f"--git-dir={self.git_dir}", f"--work-tree={self.work_tree}", *args],
            capture_output=True, text=True, check=check)

    def _git(self, *args: str) -> str:
        return self._run(*args).stdout.strip()

    def _clear_stale_lock(self) -> None:
        lock = self.git_dir / "index.lock"
        try:
            if time.time() - lock.stat().st_mtime > STALE_LOCK_SECONDS:
                lock.unlink()
        except FileNotFoundError:
            pass

    def _has_head(self) -> bool:
        return self._run("rev-parse", "--verify", "--quiet", "HEAD", check=False).returncode == 0

    def _add_all(self) -> None:
        # Nextcloud may delete/rename files mid-add; --ignore-errors adds what it can.
        # Retry once; if it still reports errors, carry on with whatever was staged.
        for _ in range(2):
            if self._run("add", "-A", "--ignore-errors", check=False).returncode == 0:
                break
        self._unstage_gitlinks()

    def _unstage_gitlinks(self) -> None:
        """Keep nested repos (overleaf, web-demo, ...) out of the journal entirely: `add -A`
        records them as gitlinks (mode 160000); put the index back to HEAD for those paths
        (drops new ones, freezes any gitlink an older journal already committed)."""
        out = self._run("ls-files", "-s", "-z").stdout
        paths = [e.split("\t", 1)[1] for e in out.split("\0") if e.startswith("160000 ")]
        if not paths:
            return
        if self._has_head():
            self._run("reset", "-q", "--", *paths, check=False)
        else:
            self._run("rm", "-q", "--cached", "--", *paths, check=False)

    def prepare(self) -> None:
        """Cheap startup step: init if needed, (re)write excludes and perf config."""
        if not (self.git_dir / "HEAD").exists():
            self._git("init", "--quiet", "--initial-branch=main")
        self._clear_stale_lock()
        (self.git_dir / "info").mkdir(parents=True, exist_ok=True)
        (self.git_dir / "info" / "exclude").write_text("\n".join(EXCLUDES) + "\n")
        self._git("config", "core.untrackedCache", "true")
        self._git("config", "feature.manyFiles", "true")

    def has_baseline(self) -> bool:
        return self._has_head()

    def ensure_baseline(self) -> None:
        """Expensive on the real tree (7 GB / 72k files): first full add + commit."""
        if not self._has_head():
            self._add_all()
            self._git("commit", "--quiet", "--allow-empty", "-m", "baseline")

    def ensure_repo(self) -> None:
        self.prepare()
        self.ensure_baseline()

    def snapshot(self, message: str) -> str | None:
        self._clear_stale_lock()
        self._add_all()
        # exit 0 = nothing staged, 1 = staged changes (nested repos ignored via config)
        if self._run("diff", "--cached", "--quiet", check=False).returncode == 0:
            return None
        self._git("commit", "--quiet", "-m", message)
        return self._git("rev-parse", "HEAD")

    def changed_files(self, commit: str) -> list[str]:
        out = self._git("show", "--name-only", "--format=", commit, "--")
        return sorted(line for line in out.splitlines() if line)

    def tracked_files(self) -> list[str]:
        return sorted(self._git("ls-files").splitlines())

    def _resolve_agent_commit(self, commit: str) -> str:
        if not isinstance(commit, str) or not SHA_RE.match(commit):
            raise UndoRejected("invalid commit id")
        res = self._run("rev-parse", "--verify", "--quiet", f"{commit}^{{commit}}", check=False)
        if res.returncode != 0:
            raise UndoRejected("unknown commit")
        full = res.stdout.strip()
        if not self._git("log", "-1", "--format=%s", full).startswith("agent:"):
            raise UndoRejected("not an agent commit")
        return full

    def undo(self, commit: str) -> str:
        full = self._resolve_agent_commit(commit)
        if self._git("log", "--fixed-strings", f"--grep=This reverts commit {full}.",
                     "--format=%H", "-1"):
            raise UndoRejected("already undone")
        try:
            self.snapshot("pre-undo: user/sync changes")
        except subprocess.CalledProcessError as exc:
            raise JournalUnavailable(f"pre-undo snapshot failed: {(exc.stderr or '').strip()[-300:]}")
        # `full` is a validated 40-hex sha, so it can never be parsed as an option.
        res = self._run("revert", "--no-edit", full, check=False)
        if res.returncode != 0:
            self._abort_revert()
            raise UndoConflict((res.stderr or res.stdout).strip()[-300:])
        return self._git("rev-parse", "HEAD")

    def _abort_revert(self) -> None:
        if self._run("revert", "--abort", check=False).returncode != 0:
            self._run("reset", "--merge", check=False)
        (self.git_dir / "REVERT_HEAD").unlink(missing_ok=True)
