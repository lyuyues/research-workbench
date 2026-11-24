from backend.journal import Journal


def make(tmp_path):
    root = tmp_path / "Research"
    root.mkdir()
    (root / "a.md").write_text("v1\n")
    (root / "clip.mp4").write_bytes(b"\0" * 10)
    j = Journal(tmp_path / "git", root)
    j.ensure_repo()
    return j, root


def test_ensure_repo_commits_text_not_media(tmp_path):
    j, root = make(tmp_path)
    assert (tmp_path / "git" / "HEAD").exists()
    assert not (root / ".git").exists()          # git dir lives outside Research
    assert j.tracked_files() == ["a.md"]


def test_snapshot_none_when_clean(tmp_path):
    j, _ = make(tmp_path)
    assert j.snapshot("nothing") is None


def test_snapshot_and_changed_files(tmp_path):
    j, root = make(tmp_path)
    (root / "a.md").write_text("v2\n")
    (root / "b.md").write_text("new\n")
    sha = j.snapshot("agent: edit")
    assert sha and j.changed_files(sha) == ["a.md", "b.md"]


def test_undo_reverts(tmp_path):
    j, root = make(tmp_path)
    (root / "a.md").write_text("v2\n")
    (root / "b.md").write_text("new\n")
    sha = j.snapshot("agent: edit")
    j.undo(sha)
    assert (root / "a.md").read_text() == "v1\n"
    assert not (root / "b.md").exists()


# --- review fixes -----------------------------------------------------------
import os
import subprocess
import time

import pytest

from backend.journal import EXCLUDES, UndoConflict, UndoRejected

GIT_ID = ["-c", "user.name=t", "-c", "user.email=t@t"]


def make_nested_repo(path):
    subprocess.run(["git", "init", "-q", str(path)], check=True)
    (path / "x.tex").write_text("t\n")
    subprocess.run(["git", "-C", str(path), *GIT_ID, "add", "."], check=True)
    subprocess.run(["git", "-C", str(path), *GIT_ID, "commit", "-qm", "i"], check=True)


def test_dirty_nested_repo_is_ignored(tmp_path):
    root = tmp_path / "Research"
    root.mkdir()
    (root / "a.md").write_text("v1\n")
    make_nested_repo(root / "paper" / "overleaf")
    j = Journal(tmp_path / "git", root)
    j.ensure_repo()
    (root / "paper" / "overleaf" / "x.tex").write_text("dirty\n")
    (root / "paper" / "overleaf" / "new.tex").write_text("untracked\n")
    assert j.snapshot("agent: nothing outside") is None
    (root / "a.md").write_text("v2\n")
    sha = j.snapshot("agent: edit")
    assert sha and j.changed_files(sha) == ["a.md"]


def test_non_ascii_paths(tmp_path):
    j, root = make(tmp_path)
    (root / "Notizen-ü.md").write_text("x\n")
    sha = j.snapshot("agent: cn")
    assert j.changed_files(sha) == ["Notizen-ü.md"]
    assert "Notizen-ü.md" in j.tracked_files()


def agent_then_user_edit(tmp_path):
    j, root = make(tmp_path)
    (root / "a.md").write_text("agent\n")
    sha = j.snapshot("agent: a")
    (root / "a.md").write_text("user later\n")
    assert j.snapshot("pre-agent: user")
    return j, root, sha


def test_conflicting_undo_aborts_cleanly(tmp_path):
    j, root, sha = agent_then_user_edit(tmp_path)
    with pytest.raises(UndoConflict):
        j.undo(sha)
    assert (root / "a.md").read_text() == "user later\n"
    assert not (tmp_path / "git" / "REVERT_HEAD").exists()
    assert j._git("status", "--porcelain") == ""
    assert j.snapshot("pre-agent: next") is None


def test_undo_snapshots_pending_changes_first(tmp_path):
    j, root = make(tmp_path)
    (root / "b.md").write_text("agent\n")
    sha = j.snapshot("agent: b")
    (root / "c.md").write_text("user, not yet snapshotted\n")
    j.undo(sha)
    assert not (root / "b.md").exists()
    assert (root / "c.md").read_text() == "user, not yet snapshotted\n"
    assert "pre-undo" in j._git("log", "--format=%s")


@pytest.mark.parametrize("bad", ["", "HEAD", "--abort", "zzzzzzz", "abc", "a" * 41])
def test_undo_rejects_garbage_sha(tmp_path, bad):
    j, _ = make(tmp_path)
    with pytest.raises(UndoRejected):
        j.undo(bad)


def test_undo_rejects_non_agent_commit(tmp_path):
    j, root = make(tmp_path)
    (root / "a.md").write_text("user\n")
    sha = j.snapshot("pre-agent: user/sync changes")
    with pytest.raises(UndoRejected):
        j.undo(sha)
    with pytest.raises(UndoRejected):
        j.undo("0" * 40)  # well-formed but unknown
    assert (root / "a.md").read_text() == "user\n"


def test_nextcloud_and_office_files_excluded(tmp_path):
    j, root = make(tmp_path)
    for name in [".~lock.a.docx#", "a.md.~1a2b", "paper.docx", "fig.svg", ".owncloudsync.log"]:
        (root / name).write_text("x")
    (root / "Library").mkdir()
    (root / "Library" / "x.md").write_text("x")
    assert j.snapshot("agent: noise") is None
    for pat in ["*.~*", ".~lock.*#", "*.pptx", "*.safetensors", "Library/"]:
        assert pat in EXCLUDES


def test_ensure_repo_rewrites_exclude_and_sets_config(tmp_path):
    j, _ = make(tmp_path)
    exclude = tmp_path / "git" / "info" / "exclude"
    exclude.write_text("old\n")
    j.ensure_repo()
    assert "*.mp4" in exclude.read_text()
    assert j._git("config", "core.untrackedCache") == "true"
    assert j._git("config", "feature.manyFiles") == "true"


def test_ensure_repo_retries_missing_baseline(tmp_path):
    root = tmp_path / "Research"
    root.mkdir()
    (root / "a.md").write_text("v1\n")
    j = Journal(tmp_path / "git", root)
    j._git("init", "--quiet", "--initial-branch=main")  # simulate a crash before baseline
    j.ensure_repo()
    assert j.tracked_files() == ["a.md"]


def test_stale_index_lock_removed(tmp_path):
    j, root = make(tmp_path)
    lock = tmp_path / "git" / "index.lock"
    lock.write_text("")
    old = time.time() - 11 * 60
    os.utime(lock, (old, old))
    (root / "a.md").write_text("v2\n")
    assert j.snapshot("agent: edit")
    assert not lock.exists()


# --- review round 2 ---------------------------------------------------------
from backend.journal import JournalUnavailable


def test_nested_repos_never_enter_the_journal(tmp_path):
    root = tmp_path / "Research"
    root.mkdir()
    (root / "a.md").write_text("v1\n")
    make_nested_repo(root / "old")
    j = Journal(tmp_path / "git", root)
    j.ensure_repo()
    assert j.tracked_files() == ["a.md"]          # not even in the baseline
    # nested HEAD moves + a brand-new nested repo appears
    (root / "old" / "x.tex").write_text("moved\n")
    subprocess.run(["git", "-C", str(root / "old"), *GIT_ID, "commit", "-qam", "m"], check=True)
    make_nested_repo(root / "new")
    assert j.snapshot("agent: nested only") is None
    (root / "a.md").write_text("v2\n")
    sha = j.snapshot("agent: edit")
    assert j.changed_files(sha) == ["a.md"]
    assert j._git("ls-tree", "-r", "--name-only", "HEAD").splitlines() == ["a.md"]
    assert j._git("ls-files", "-s").count("160000") == 0


def test_existing_gitlink_from_old_journal_is_frozen(tmp_path):
    # journals created before this fix may already hold a gitlink; it must never change
    root = tmp_path / "Research"
    root.mkdir()
    (root / "a.md").write_text("v1\n")
    make_nested_repo(root / "sub")
    j = Journal(tmp_path / "git", root)
    j._git("init", "--quiet", "--initial-branch=main")
    j._git("add", "-A")
    j._git("commit", "-qm", "baseline")
    old = j._git("ls-tree", "HEAD", "sub")
    j.ensure_repo()
    subprocess.run(["git", "-C", str(root / "sub"), *GIT_ID, "commit", "-q", "--allow-empty", "-m", "m"],
                   check=True)
    (root / "a.md").write_text("v2\n")
    sha = j.snapshot("agent: edit")
    assert j.changed_files(sha) == ["a.md"]
    assert j._git("ls-tree", "HEAD", "sub") == old


def test_double_undo_is_rejected(tmp_path):
    j, root = make(tmp_path)
    (root / "b.md").write_text("b\n")
    sha = j.snapshot("agent: b")
    j.undo(sha)
    with pytest.raises(UndoRejected, match="already undone"):
        j.undo(sha)
    with pytest.raises(UndoRejected, match="already undone"):
        j.undo(sha[:7])


def test_pre_undo_snapshot_failure_is_unavailable(tmp_path, monkeypatch):
    j, root = make(tmp_path)
    (root / "b.md").write_text("b\n")
    sha = j.snapshot("agent: b")

    def broken(message):
        raise subprocess.CalledProcessError(128, ["git"], stderr="index locked")

    monkeypatch.setattr(j, "snapshot", broken)
    with pytest.raises(JournalUnavailable):
        j.undo(sha)
    assert (root / "b.md").exists()
