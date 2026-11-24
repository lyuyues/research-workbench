import pytest

from backend.projects import Projects, parse


def test_parse_defaults_and_paths(tmp_path):
    (tmp_path / "projects.yaml").write_text(
        "projects:\n  - name: Sleep\n  - {name: Beta, code: V, dir: studies/v, paper: studies/v/tex}\n")
    p = Projects(tmp_path)
    assert p.names() == ["Sleep", "Beta"]
    assert p.get("Sleep").code == "S" and p.get("Sleep").dir == "Sleep"
    assert p.paper_dir("Sleep") == "Sleep/paper/overleaf" and p.paper_dir("Beta") == "studies/v/tex"
    with pytest.raises(ValueError):
        p.get("Nope")


def test_missing_file_means_no_projects(tmp_path):
    assert Projects(tmp_path).all() == []


@pytest.mark.parametrize("doc", [
    {"projects": [{"name": "../x"}]},
    {"projects": [{"name": "A"}, {"name": "Ab", "code": "A"}]},
    {"projects": [{"name": "A", "dir": "/etc"}]},
    {"projects": [{"name": "A", "dir": "x/../../y"}]},
    {"projects": "Sleep"},
])
def test_parse_rejects(doc):
    with pytest.raises(ValueError):
        parse(doc)


def test_reloads_on_change(tmp_path):
    import os
    f = tmp_path / "projects.yaml"
    f.write_text("projects:\n  - name: A\n")
    p = Projects(tmp_path)
    assert p.names() == ["A"]
    f.write_text("projects:\n  - name: A\n  - name: B\n")
    os.utime(f, (f.stat().st_mtime + 5, f.stat().st_mtime + 5))
    assert p.names() == ["A", "B"]
