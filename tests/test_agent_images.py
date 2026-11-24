import base64

import pytest

from backend.agent import IMAGE_MAX, build_prompt, save_images

PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 32


def data_url(raw: bytes, mime: str = "image/png") -> str:
    return f"data:{mime};base64," + base64.b64encode(raw).decode()


def test_save_images_writes_files(tmp_path):
    paths = save_images([data_url(PNG), base64.b64encode(b"\xff\xd8\xff" + b"x" * 10).decode()], tmp_path / "imgs")
    assert [p.suffix for p in paths] == [".png", ".jpg"]
    assert paths[0].read_bytes() == PNG


@pytest.mark.parametrize("bad", ["not base64!!", data_url(b"<svg></svg>", "image/svg+xml")])
def test_save_images_rejects(tmp_path, bad):
    with pytest.raises(ValueError):
        save_images([bad], tmp_path)
    assert not tmp_path.exists() or not any(tmp_path.iterdir())


def test_save_images_limits_count(tmp_path):
    with pytest.raises(ValueError):
        save_images([data_url(PNG)] * (IMAGE_MAX + 1), tmp_path)


def test_build_prompt_lists_images(tmp_path):
    p = tmp_path / "a.png"
    out = build_prompt("what is this?", {"panel": "story"}, [p])
    assert str(p) in out and "Read tool" in out and out.endswith("what is this?")
