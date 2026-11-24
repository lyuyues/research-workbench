import { useCallback, useEffect, useRef, useState } from "react";
import { pdfjs } from "./PdfView";

/** Stand-alone page (#/pdf/<Alpha|Beta>) for a second screen: the paper draft's PDF, rebuilt on every save.
 *  New versions are rendered off-screen and swapped in, so the scroll position stays where the user was reading. */
interface Status { state: string; available: boolean; pdf_mtime: number | null; error?: string | null; seconds?: number;
  started?: number; warnings?: string[] }

export function LivePdf({ project }: { project: string }) {
  const [st, setSt] = useState<Status | null>(null);
  const [shown, setShown] = useState<number | null>(null);
  const [zoom, setZoom] = useState(() => { try { return Number(localStorage.getItem("livepdf-zoom")) || 1.4; } catch { return 1.4; } });
  const box = useRef<HTMLDivElement>(null);
  const rendering = useRef(false);

  const render = useCallback(async (mtime: number, z: number) => {
    if (rendering.current || !box.current) return;
    rendering.current = true;
    try {
      const lib = await pdfjs();
      const doc = await lib.getDocument({ url: `/api/paper/${encodeURIComponent(project)}/pdf?v=${mtime}` }).promise;
      const frag = document.createElement("div");
      frag.className = "livepdf-pages";
      const dpr = window.devicePixelRatio || 1;
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const vp = page.getViewport({ scale: z });
        const c = document.createElement("canvas");
        c.width = Math.floor(vp.width * dpr); c.height = Math.floor(vp.height * dpr);
        c.style.width = `${Math.floor(vp.width)}px`; c.style.height = `${Math.floor(vp.height)}px`;
        c.dataset.page = String(n);
        await page.render({ canvasContext: c.getContext("2d")!, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;
        frag.appendChild(c);
      }
      const el = box.current;
      const top = el.scrollTop, left = el.scrollLeft;
      el.querySelectorAll("canvas").forEach((c) => { c.width = 0; c.height = 0; });
      el.replaceChildren(frag);
      el.scrollTop = top; el.scrollLeft = left;
      setShown(mtime);
      void doc.destroy();
    } finally { rendering.current = false; }
  }, [project]);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/paper/${encodeURIComponent(project)}/pdf/status`);
        if (r.ok && !stop) setSt(await r.json());
      } catch { /* offline: try again */ }
    };
    void tick();
    const id = window.setInterval(tick, 3000);
    return () => { stop = true; window.clearInterval(id); };
  }, [project]);

  useEffect(() => { if (st?.pdf_mtime && st.pdf_mtime !== shown) void render(st.pdf_mtime, zoom); }, [st?.pdf_mtime]); // eslint-disable-line react-hooks/exhaustive-deps
  const setZ = (z: number) => {
    const nz = Math.min(3, Math.max(0.6, Math.round(z * 10) / 10));
    setZoom(nz);
    try { localStorage.setItem("livepdf-zoom", String(nz)); } catch { /* private mode */ }
    if (st?.pdf_mtime) { setShown(null); void render(st.pdf_mtime, nz); }
  };
  useEffect(() => { document.title = `${project} PDF — live`; }, [project]);

  const building = st?.state === "building";
  return (
    <div className="livepdf">
      <div className="livepdf-bar">
        <b>{project}</b>
        <span className="muted small">platform draft · updates after every save</span>
        <span className={`small livepdf-state ${st?.state ?? ""}`}>
          {!st ? "…" : !st.available ? "LaTeX not installed on the server"
            : building ? "⟳ compiling…" : st.state === "error" ? "⚠️ LaTeX error — showing the last good PDF"
            : st.pdf_mtime ? `✓ ${new Date(st.pdf_mtime).toLocaleTimeString()}${st.seconds ? ` (${st.seconds}s)` : ""}` : "no PDF yet"}
        </span>
        <span className="livepdf-zoom">
          <button className="ask" onClick={() => setZ(zoom - 0.1)} aria-label="Zoom out">−</button>
          <span className="small">{Math.round(zoom * 100)}%</span>
          <button className="ask" onClick={() => setZ(zoom + 0.1)} aria-label="Zoom in">+</button>
        </span>
      </div>
      {st?.state === "error" && st.error && <pre className="livepdf-error">{st.error}</pre>}
      {st?.warnings && st.warnings.length > 0 && <div className="small muted livepdf-warn">{st.warnings.join(" · ")}</div>}
      <div className="livepdf-scroll" ref={box}>{!st?.pdf_mtime && <p className="muted" style={{ padding: 20 }}>
        {building ? "Compiling the first PDF (about 40 s)…" : "Waiting for the first PDF…"}</p>}</div>
    </div>
  );
}
