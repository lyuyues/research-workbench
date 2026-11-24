import time

from backend import paper_pdf
from backend.paper_pdf import PaperPdf


def test_build_on_newer_draft_and_coalesce(tmp_path, monkeypatch):
    d = tmp_path / "R/Alpha/paper/overleaf/texfiles"
    d.mkdir(parents=True)
    (d / "a.tex").write_text("x")
    fake = tmp_path / "tectonic"; fake.write_text("")
    monkeypatch.setattr(paper_pdf, "TECTONIC", fake)
    (tmp_path / "R/projects.yaml").write_text("projects:\n  - {name: Alpha}\n")
    pp = PaperPdf(tmp_path / "R", tmp_path / "state")
    runs = []

    def compile_(p):
        runs.append(p); time.sleep(0.05)
        pp.out.mkdir(parents=True, exist_ok=True); pp.pdf_path(p).write_bytes(b"%PDF")
        return {"state": "ok", "error": None}
    monkeypatch.setattr(pp, "_compile", compile_)
    assert pp.status("Alpha")["state"] == "building"     # draft newer than any build → starts one
    pp.build("Alpha")                                      # save during the build → exactly one more
    for _ in range(100):
        if pp.status("Alpha", auto=False)["state"] != "building":
            break
        time.sleep(0.02)
    st = pp.status("Alpha")
    assert st["state"] == "ok" and st["pdf_mtime"] and runs == ["Alpha", "Alpha"]
