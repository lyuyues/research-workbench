import subprocess

import pytest

from backend.overleaf import Overleaf, OverleafConflict, clean, leaks


def git(*a, cwd):
    subprocess.run(["git", *a], cwd=cwd, check=True, capture_output=True)


def test_clean_strips_watermarks_keeps_latex():
    src = "\n".join([
        "%% ===== header written by Claude",
        "% TODO(Q2): confirm site",
        "\\section{Study}",
        "Text with 50\\% done. % TODO: number",
        "% \\begin{figure}  (the user: commented out for now)",
        "Keep this line.",
        "% NOTE(Claude): check",
        "",
        "",
        "",
        "End.",
    ])
    out = clean(src)
    assert "Claude" not in out and "TODO" not in out
    assert "Text with 50\\% done." in out and "% \\begin{figure}" in out and "\\section{Study}" in out
    assert "\n\n\n" not in out
    assert leaks(out) == []
    assert leaks("\\alice{🤖 hi}")


@pytest.fixture
def env(tmp_path):
    remote = tmp_path / "remote.git"
    git("init", "-q", "--bare", "-b", "master", str(remote), cwd=tmp_path)
    collab = tmp_path / "collab"
    git("clone", "-q", str(remote), str(collab), cwd=tmp_path)
    (collab / "texfiles").mkdir()
    (collab / "texfiles/a.tex").write_text("Line one.\nLine two.\nLine three.\n")
    for c in (["config", "user.email", "c@x"], ["config", "user.name", "C"], ["add", "."], ["commit", "-qm", "init"],
              ["push", "-q", "origin", "HEAD:master"]):
        git(*c, cwd=collab)
    clones = tmp_path / "clones"
    clones.mkdir()
    git("clone", "-q", str(remote), str(clones / "Alpha"), cwd=tmp_path)
    git("config", "user.email", "y@x", cwd=clones / "Alpha"); git("config", "user.name", "the user", cwd=clones / "Alpha")
    research = tmp_path / "Research"
    research.mkdir()
    (research / "projects.yaml").write_text("projects:\n  - {name: Alpha}\n")
    draft = research / "Alpha/paper/overleaf/texfiles"
    draft.mkdir(parents=True)
    (draft / "a.tex").write_text("%% Claude: rewrite below\nLine one.\nLine two, improved.\nLine three.\n")
    ov = Overleaf(research, tmp_path / "state", clones)
    ov.pull_in("Alpha")  # first run records the base
    return ov, collab, draft


def test_preview_publish_and_merge_back(env):
    ov, collab, draft = env
    pv = ov.preview("Alpha")
    assert [f["path"] for f in pv["files"]] == ["texfiles/a.tex"]
    assert "Claude" not in pv["files"][0]["diff"] and "+Line two, improved." in pv["files"][0]["diff"]
    assert ov.publish("Alpha", pv["digest"])["published"] == ["texfiles/a.tex"]
    git("pull", "-q", cwd=collab)
    assert (collab / "texfiles/a.tex").read_text() == "Line one.\nLine two, improved.\nLine three.\n"
    # a collaborator edits line three on Overleaf -> merged into our draft, our %% note kept
    (collab / "texfiles/a.tex").write_text("Line one.\nLine two, improved.\nLine 3 (co-advisor).\n")
    git("commit", "-qam", "k", cwd=collab); git("push", "-q", "origin", "HEAD:master", cwd=collab)
    pv = ov.preview("Alpha")
    assert pv["pulled"]["merged"] == ["texfiles/a.tex"] and pv["files"] == []
    assert (draft / "a.tex").read_text() == "%% Claude: rewrite below\nLine one.\nLine two, improved.\nLine 3 (co-advisor).\n"


def test_publish_refuses_leaks_and_stale_preview(env):
    ov, collab, draft = env
    (draft / "a.tex").write_text("Line one.\n\\textbf{🤖 draft}\nLine three.\n")
    pv = ov.preview("Alpha")
    assert pv["files"][0]["leaks"]
    with pytest.raises(OverleafConflict):
        ov.publish("Alpha", pv["digest"])
    (draft / "a.tex").write_text("Line one.\nClean.\nLine three.\n")
    with pytest.raises(OverleafConflict):
        ov.publish("Alpha", pv["digest"])  # draft changed since that preview


def test_scope_main_and_samples(env):
    ov, collab, draft = env
    root = draft.parent
    (root / "main.tex").write_text("% template comment\n\\newcommand{\\claude}[1]{#1}\n\\begin{document}\n")
    (root / "samples").mkdir()
    (root / "samples/x.tex").write_text("% sample\n")
    files = {f["path"]: f for f in ov.preview("Alpha")["files"]}
    assert "samples/x.tex" not in files and "main.tex" not in files  # main.tex not on Overleaf yet → not ours to add
    (collab / "main.tex").write_text("% template comment\n\\newcommand{\\claude}[1]{#1}\n\\begin{document}\n")
    git("add", ".", cwd=collab); git("commit", "-qm", "m", cwd=collab); git("push", "-q", "origin", "HEAD:master", cwd=collab)
    files = {f["path"]: f for f in ov.preview("Alpha")["files"]}
    assert "-\\newcommand{\\claude}[1]{#1}" in files["main.tex"]["diff"] and "-% template comment" not in files["main.tex"]["diff"]
