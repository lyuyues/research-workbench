"""Scanned PDF -> same PDF + an invisible OCR text layer, so the Reading reader can select / highlight / quote it.

Runs with the audiobooks venv (pymupdf + rapidocr_onnxruntime; the platform venv has neither):
    ~/audiobooks/.venv/bin/python backend/pdf_ocr.py <pdf> [--force]

The page images are untouched (same size, same coordinates), so highlights made in Zotero on the original file
still line up. Progress goes to <pdf minus .pdf>.ocr.json: {state: running|done|skipped|error, done, total, ...};
the platform shows it in the reader. A PDF that already has text on most pages is skipped.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

DPI = 200
FONT = "china-s"  # PyMuPDF built-in CJK font (covers Latin too); render mode 3 = invisible


def status_path(pdf: Path) -> Path:
    return pdf.with_name(pdf.stem + ".ocr.json")


def write_status(pdf: Path, **st) -> None:
    f = status_path(pdf)
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps({**st, "updated": int(time.time() * 1000)}, ensure_ascii=False))
    os.replace(tmp, f)


def has_text(doc) -> bool:
    n = len(doc)
    sample = range(0, n, max(1, n // 20))
    return sum(1 for i in sample if len(doc[i].get_text().strip()) > 30) >= 0.5 * len(sample)


_OCR = None


def ocr_page(args: tuple[str, int]) -> list[tuple[list[list[float]], str]]:
    import pymupdf
    from rapidocr_onnxruntime import RapidOCR
    global _OCR
    if _OCR is None:
        os.nice(10)  # the server also hosts the study sites
        _OCR = RapidOCR(intra_op_num_threads=2, inter_op_num_threads=1)
    path, i = args
    png = pymupdf.open(path)[i].get_pixmap(dpi=DPI).tobytes("png")
    res, _ = _OCR(png)
    return [(box, text) for box, text, _score in (res or []) if text and text.strip()]


def add_layer(page, lines) -> None:
    import pymupdf
    k = 72 / DPI
    # pages with a /Rotate or a cropbox offset: OCR ran on the displayed image, so map back to unrotated space
    m = page.derotation_matrix
    for box, text in lines:
        xs = [p[0] * k for p in box]
        ys = [p[1] * k for p in box]
        x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
        h = y1 - y0
        if h <= 1 or x1 - x0 <= 1:
            continue
        size = h * 0.85
        width = pymupdf.get_text_length(text, fontname=FONT, fontsize=size)
        if width <= 0:
            continue
        origin = pymupdf.Point(x0 + page.cropbox.x0, y1 - h * 0.18 + page.cropbox.y0) * m
        page.insert_text(origin, text, fontname=FONT, fontsize=size, render_mode=3,
                         morph=(origin, pymupdf.Matrix((x1 - x0) / width, 1)), rotate=page.rotation)


def run(pdf: Path, force: bool = False) -> str:
    import pymupdf
    from concurrent.futures import ProcessPoolExecutor
    doc = pymupdf.open(pdf)
    n = len(doc)
    if not force and has_text(doc):
        write_status(pdf, state="skipped", done=0, total=n, reason="the PDF already has a text layer")
        return "skipped"
    write_status(pdf, state="running", done=0, total=n, started=int(time.time() * 1000))
    pages: list = []
    with ProcessPoolExecutor(max_workers=min(10, os.cpu_count() or 2)) as ex:
        for lines in ex.map(ocr_page, [(str(pdf), i) for i in range(n)], chunksize=2):
            pages.append(lines)
            if len(pages) % 5 == 0 or len(pages) == n:
                write_status(pdf, state="running", done=len(pages), total=n)
    for i, lines in enumerate(pages):
        add_layer(doc[i], lines)
    tmp = pdf.with_suffix(".ocr-tmp.pdf")
    doc.save(tmp, garbage=3, deflate=True)
    doc.close()
    os.replace(tmp, pdf)
    write_status(pdf, state="done", done=n, total=n, lines=sum(len(p) for p in pages))
    return "done"


if __name__ == "__main__":
    target = Path(sys.argv[1])
    try:
        print(run(target, force="--force" in sys.argv))
    except Exception as exc:  # noqa: BLE001 - surface any failure to the reader
        write_status(target, state="error", error=str(exc)[:300])
        raise
