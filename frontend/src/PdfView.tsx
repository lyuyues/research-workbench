import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "pdfjs-dist";

/** Highlight rects are in PDF user space (points, origin bottom-left) — the same as Zotero's annotationPosition. */
export interface Mark { id: string; page: number; rects: number[][]; color: string; zotero?: boolean }
/** A PDF bookmark (table of contents entry); page is 0-based, top in PDF points (if the bookmark has one). */
export interface OutlineItem { title: string; page: number | null; top?: number; items: OutlineItem[] }

type RawOutline = { title: string; dest: unknown; items?: RawOutline[] };
async function resolveOutline(d: PDFDocumentProxy, raw: RawOutline[] | null, depth = 0, budget = { n: 3000 }): Promise<OutlineItem[]> {
  const out: OutlineItem[] = [];
  for (const o of raw ?? []) {
    if (--budget.n < 0) break;
    let page: number | null = null, top: number | undefined;
    try {
      const dest = (typeof o.dest === "string" ? await d.getDestination(o.dest) : o.dest) as unknown[] | null;
      if (Array.isArray(dest) && dest[0] != null) {
        page = typeof dest[0] === "number" ? dest[0] : await d.getPageIndex(dest[0] as Parameters<PDFDocumentProxy["getPageIndex"]>[0]);
        const kind = (dest[1] as { name?: string } | null)?.name;
        if (kind === "XYZ" && typeof dest[3] === "number") top = dest[3];
        else if ((kind === "FitH" || kind === "FitBH") && typeof dest[2] === "number") top = dest[2];
      }
    } catch { /* unresolvable bookmark: keep the title, no target */ }
    out.push({ title: (o.title || "").trim() || "(untitled)", page, top,
      items: depth < 6 ? await resolveOutline(d, o.items ?? [], depth + 1, budget) : [] });
  }
  return out;
}

export interface Selection { page: number; rects: number[][]; text: string; top: number; page_height: number; x: number; y: number }

type Pdfjs = typeof import("pdfjs-dist");
let lib: Promise<Pdfjs> | null = null;
export function pdfjs(): Promise<Pdfjs> {
  lib ??= Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]).then(([m, w]) => {
    m.GlobalWorkerOptions.workerSrc = (w as { default: string }).default;
    return m;
  });
  return lib;
}

function mergeRects(rects: number[][]): number[][] {
  const rs = rects.filter((r) => r[2] - r[0] > 0.5 && r[3] - r[1] > 0.5).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const out: number[][] = [];
  for (const r of rs) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[1] - r[1]) < 2.5 && Math.abs(last[3] - r[3]) < 2.5 && r[0] <= last[2] + 3) {
      last[0] = Math.min(last[0], r[0]); last[2] = Math.max(last[2], r[2]);
      last[1] = Math.min(last[1], r[1]); last[3] = Math.max(last[3], r[3]);
    } else out.push([...r]);
  }
  return out.map((r) => r.map((v) => Math.round(v * 100) / 100));
}

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;
export const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));

/** Canvas size limits. iOS Safari paints any canvas over ~16.7M pixels blank, and also blanks canvases once
 * the total canvas memory passes a few hundred MB, so phones/tablets get a lower per-page budget. */
const MAX_CANVAS_PX = 16_000_000;
const MAX_CANVAS_PX_TOUCH = 8_000_000;
const maxCanvasPx = () =>
  typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches ? MAX_CANVAS_PX_TOUCH : MAX_CANVAS_PX;

/** Backing-store scale for a page canvas: the device pixel ratio, lowered (sharpness traded for a picture)
 * so that width × height × scale² stays within maxPx. */
export function canvasScale(cssW: number, cssH: number, dpr: number, maxPx: number): number {
  const area = Math.max(1, cssW * cssH);
  return Math.min(dpr || 1, Math.sqrt(maxPx / area));
}

/** Give a canvas's pixel memory back right away (Safari otherwise holds it until GC and counts it against its limit). */
const freeCanvas = (c: HTMLCanvasElement | null | undefined) => { if (c) { c.width = 0; c.height = 0; } };

export function PdfView({ url, zoom, marks, colors, active, jump, onSelect, onMarkClick, onZoom, onPage, onOutline }: {
  url: string; zoom: number; marks: Mark[]; colors: Record<string, string>; active: string | null;
  jump: { page: number; top?: number; n: number } | null;
  onSelect: (s: Selection | null) => void; onMarkClick: (id: string) => void;
  onZoom?: (z: number) => void;
  /** The page (0-based) at the reading line, reported as the user scrolls. */
  onPage?: (page: number) => void;
  /** The PDF's own table of contents ([] when it has none), once the document is open. */
  onOutline?: (items: OutlineItem[]) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  // Pinch zoom (trackpad ctrl+wheel, Safari gesture events, two-finger touch): preview with a CSS
  // transform while the fingers move, then commit one re-render and keep the point under the fingers still.
  const pinch = useRef<{ f: number; cx: number; cy: number; px: number; py: number; timer?: number } | null>(null);
  const anchor = useRef<{ px: number; py: number; cx: number; cy: number; r: number } | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const onZoomRef = useRef(onZoom);
  onZoomRef.current = onZoom;
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const onOutlineRef = useRef(onOutline);
  onOutlineRef.current = onOutline;
  const [error, setError] = useState<string | null>(null);
  const [base, setBase] = useState<{ w: number; h: number }[]>([]);
  const [width, setWidth] = useState(800);
  const [vps, setVps] = useState<Record<number, PageViewport>>({});
  const pages = useRef<Record<number, PDFPageProxy>>({});
  const rendered = useRef<Set<number>>(new Set());

  useEffect(() => {
    let live = true;
    let loaded: PDFDocumentProxy | null = null;
    setDoc(null); setError(null); setBase([]); setVps({}); pages.current = {}; rendered.current = new Set();
    pdfjs().then(async (m) => {
      const d = await m.getDocument({ url, isEvalSupported: false }).promise;
      loaded = d;
      if (!live) { void d.destroy(); return; }
      const sizes = [];
      for (let i = 1; i <= d.numPages; i++) {
        const p = await d.getPage(i);
        pages.current[i - 1] = p;
        const v = p.getViewport({ scale: 1 });
        sizes.push({ w: v.width, h: v.height });
      }
      if (live) { setBase(sizes); setDoc(d); }
      const toc = await resolveOutline(d, await d.getOutline().catch(() => null) as RawOutline[] | null).catch(() => []);
      if (live) onOutlineRef.current?.(toc);
    }).catch((e: unknown) => live && setError(`Could not open the PDF (${e instanceof Error ? e.message : String(e)})`));
    return () => { live = false; void loaded?.destroy(); };
  }, [url]);

  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(Math.max(280, el.clientWidth - 24)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const start = (cx: number, cy: number) => {
      const r = el.getBoundingClientRect();
      const x = cx - r.left, y = cy - r.top;
      if (!pinch.current) pinch.current = { f: 1, cx: x, cy: y, px: x + el.scrollLeft, py: y + el.scrollTop };
      return pinch.current;
    };
    const preview = () => {
      const p = pinch.current, i = inner.current;
      if (!p || !i) return;
      const f = clampZoom(zoomRef.current * p.f) / zoomRef.current;
      i.style.transformOrigin = `${p.px}px ${p.py}px`;
      i.style.transform = `scale(${f})`;
    };
    const commit = () => {
      const p = pinch.current;
      pinch.current = null;
      if (!p) return;
      const z = clampZoom(zoomRef.current * p.f);
      if (inner.current) inner.current.style.transform = "";
      if (z === zoomRef.current || !onZoomRef.current) return;
      anchor.current = { px: p.px, py: p.py, cx: p.cx, cy: p.cy, r: z / zoomRef.current };
      onZoomRef.current(z);
    };
    const later = (p: { timer?: number }, ms: number) => { window.clearTimeout(p.timer); p.timer = window.setTimeout(commit, ms); };
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey || !onZoomRef.current) return; // trackpad pinch arrives as ctrl+wheel
      e.preventDefault();
      const p = start(e.clientX, e.clientY);
      p.f *= Math.exp(-e.deltaY / 100);
      preview();
      later(p, 180);
    };
    type GestureEvent = Event & { scale: number; clientX: number; clientY: number };
    let g0 = 1;
    const gstart = (e: Event) => { e.preventDefault(); const ge = e as GestureEvent; start(ge.clientX, ge.clientY); g0 = 1; };
    const gchange = (e: Event) => { e.preventDefault(); const ge = e as GestureEvent; const p = start(ge.clientX, ge.clientY); p.f *= ge.scale / g0; g0 = ge.scale; preview(); };
    const gend = (e: Event) => { e.preventDefault(); commit(); };
    let d0 = 0;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const tstart = (e: TouchEvent) => {
      if (e.touches.length !== 2 || !onZoomRef.current) return;
      d0 = dist(e.touches);
      start((e.touches[0].clientX + e.touches[1].clientX) / 2, (e.touches[0].clientY + e.touches[1].clientY) / 2);
    };
    const tmove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || !pinch.current || !d0) return;
      e.preventDefault();
      const d = dist(e.touches);
      pinch.current.f *= d / d0;
      d0 = d;
      preview();
    };
    const tend = (e: TouchEvent) => { if (e.touches.length < 2 && d0) { d0 = 0; commit(); } };
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("gesturestart", gstart);
    el.addEventListener("gesturechange", gchange);
    el.addEventListener("gestureend", gend);
    el.addEventListener("touchstart", tstart, { passive: true });
    el.addEventListener("touchmove", tmove, { passive: false });
    el.addEventListener("touchend", tend);
    el.addEventListener("touchcancel", tend);
    return () => {
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("gesturestart", gstart);
      el.removeEventListener("gesturechange", gchange);
      el.removeEventListener("gestureend", gend);
      el.removeEventListener("touchstart", tstart);
      el.removeEventListener("touchmove", tmove);
      el.removeEventListener("touchend", tend);
      el.removeEventListener("touchcancel", tend);
      if (pinch.current?.timer) window.clearTimeout(pinch.current.timer);
    };
  }, []);

  const scale = base.length ? (width / base[0].w) * zoom : 1;

  // After a pinch commits, keep the content point that was under the fingers in place; any other scale
  // change (zoom buttons, side panel, full screen, window width) keeps the same spot of the document.
  const prevScale = useRef(scale);
  useLayoutEffect(() => {
    const a = anchor.current, el = box.current, r = scale / prevScale.current;
    prevScale.current = scale;
    if (!el) return;
    if (a) {
      anchor.current = null;
      el.scrollLeft = a.px * a.r - a.cx;
      el.scrollTop = a.py * a.r - a.cy;
    } else if (r !== 1 && Number.isFinite(r) && r > 0) {
      el.scrollTop = el.scrollTop * r;
    }
  }, [scale]);

  // (re)render pages near the viewport
  useEffect(() => {
    const el = box.current;
    if (!doc || !el) return;
    rendered.current = new Set();
    let live = true;
    const canvases = new Set<HTMLCanvasElement>();
    const maxPx = maxCanvasPx();
    const next: Record<number, PageViewport> = {};
    Object.entries(pages.current).forEach(([i, p]) => { next[Number(i)] = p.getViewport({ scale }); });
    setVps(next);
    const draw = async (i: number) => {
      if (rendered.current.has(i)) return;
      rendered.current.add(i);
      const m = await pdfjs();
      const page = pages.current[i];
      const holder = el.querySelector<HTMLDivElement>(`[data-page="${i}"]`);
      if (!page || !holder) return;
      const vp = page.getViewport({ scale });
      const s = canvasScale(vp.width, vp.height, window.devicePixelRatio || 1, maxPx);
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(vp.width * s); canvas.height = Math.floor(vp.height * s);
      canvas.style.width = `${vp.width}px`; canvas.style.height = `${vp.height}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      canvases.add(canvas);
      await page.render({ canvasContext: ctx, viewport: vp, transform: s !== 1 ? [s, 0, 0, s, 0, 0] : undefined }).promise;
      const text = document.createElement("div");
      text.className = "textLayer";
      const tl = new m.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport: vp });
      await tl.render();
      // Zoom changed or the page scrolled far away while drawing: drop this canvas instead of attaching it.
      if (!live || !rendered.current.has(i)) { freeCanvas(canvas); canvases.delete(canvas); return; }
      const old = holder.querySelector("canvas");
      if (old) { freeCanvas(old); canvases.delete(old); old.remove(); }
      holder.querySelector(".textLayer")?.remove();
      holder.prepend(canvas);
      holder.append(text);
    };
    // Pages far from the viewport release their canvas (redrawn when they come back), which keeps the
    // total canvas memory bounded at high zoom.
    const release = (i: number, holder: HTMLElement) => {
      rendered.current.delete(i);
      const c = holder.querySelector("canvas");
      if (c) { freeCanvas(c); canvases.delete(c); c.remove(); }
    };
    const io = new IntersectionObserver((es) => es.forEach((e) => {
      const i = Number((e.target as HTMLElement).dataset.page);
      if (e.isIntersecting) void draw(i); else if (rendered.current.has(i)) release(i, e.target as HTMLElement);
    }), { root: el, rootMargin: "800px 0px" });
    el.querySelectorAll("[data-page]").forEach((p) => io.observe(p));
    return () => { live = false; io.disconnect(); canvases.forEach(freeCanvas); canvases.clear(); };
  }, [doc, scale]);

  // Each jump runs once. (It used to re-run whenever the viewports were rebuilt — zoom, side panel,
  // full screen, window resize — pulling the reader back to the last highlight / start page.)
  const jumped = useRef<typeof jump>(null);
  useEffect(() => {
    const el = box.current;
    if (!jump || !el || jumped.current === jump) return;
    const holder = el.querySelector<HTMLDivElement>(`[data-page="${jump.page}"]`);
    if (!holder) return;
    const vp = vps[jump.page];
    if (jump.top != null && !vp) return;   // wait for the page's viewport to place it precisely
    jumped.current = jump;
    const dy = jump.top != null && vp ? vp.convertToViewportPoint(0, jump.top)[1] - 60 : 0;
    el.scrollTo({ top: holder.offsetTop + Math.max(0, dy), behavior: "smooth" });
  }, [jump, vps]);

  const onPageRef = useRef(onPage);
  onPageRef.current = onPage;
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let t: number | undefined;
    const report = () => {
      const line = el.scrollTop + el.clientHeight / 3;
      let cur = 0;
      el.querySelectorAll<HTMLElement>("[data-page]").forEach((h) => { if (h.offsetTop <= line) cur = Number(h.dataset.page); });
      onPageRef.current?.(cur);
    };
    const onScroll = () => { window.clearTimeout(t); t = window.setTimeout(report, 250); };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => { el.removeEventListener("scroll", onScroll); window.clearTimeout(t); };
  }, [doc]);

  const pageOf = (n: Node | null) => (n instanceof Element ? n : n?.parentElement)?.closest<HTMLElement>("[data-page]") ?? null;

  const onUp = () => setTimeout(() => {
    const sel = window.getSelection();
    const el = box.current;
    if (!sel || sel.isCollapsed || !sel.rangeCount || !el) return;
    const range = sel.getRangeAt(0);
    const holder = pageOf(range.startContainer);
    if (!holder || !el.contains(holder)) return;
    const page = Number(holder.dataset.page);
    const vp = vps[page];
    if (!vp) return;
    const hr = holder.getBoundingClientRect();
    const rects: number[][] = [];
    for (const r of Array.from(range.getClientRects())) {
      if (r.bottom < hr.top || r.top > hr.bottom || r.width < 1) continue;
      const [x1, y1] = vp.convertToPdfPoint(r.left - hr.left, r.bottom - hr.top);
      const [x2, y2] = vp.convertToPdfPoint(r.right - hr.left, r.top - hr.top);
      rects.push([Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)]);
    }
    const merged = mergeRects(rects);
    const text = sel.toString().replace(/\s+/g, " ").trim();
    if (!merged.length || !text) return;
    const last = range.getClientRects()[range.getClientRects().length - 1] ?? hr;
    const br = el.getBoundingClientRect();
    onSelect({ page, rects: merged, text, top: Math.max(...merged.map((r) => r[3])), page_height: base[page]?.h ?? 792,
      x: Math.min(last.right - br.left, br.width - 260), y: last.bottom - br.top + 6 });
  }, 10);

  const onClick = (e: React.MouseEvent) => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const holder = pageOf(e.target as Node);
    if (!holder) { onSelect(null); return; }
    const page = Number(holder.dataset.page);
    const vp = vps[page];
    if (!vp) return;
    const hr = holder.getBoundingClientRect();
    const [x, y] = vp.convertToPdfPoint(e.clientX - hr.left, e.clientY - hr.top);
    const hit = marks.find((m) => m.page === page && m.rects.some((r) => x >= r[0] - 1 && x <= r[2] + 1 && y >= r[1] - 1 && y <= r[3] + 1));
    if (hit) onMarkClick(hit.id); else onSelect(null);
  };

  if (error) return <p className="error">{error}</p>;
  return (
    <div className="pdf-box" ref={box} onMouseUp={onUp} onTouchEnd={onUp} onClick={onClick}>
      {!doc && <p className="muted">Loading PDF…</p>}
      <div className="pdf-pages" ref={inner}>
      {doc && base.map((s, i) => (
        <div key={`${i}-${scale}`} className="pdf-page" data-page={i}
          style={{ width: s.w * scale, height: s.h * scale, ["--scale-factor" as string]: scale }}>
          <div className="pdf-marks">
            {vps[i] && marks.filter((m) => m.page === i).flatMap((m) => m.rects.map((r, k) => {
              const [a, b, c, d] = vps[i].convertToViewportRectangle(r);
              return <div key={`${m.id}-${k}`} className={`mark${m.zotero ? " zotero" : ""}${m.id === active ? " active" : ""}`}
                style={{ left: Math.min(a, c), top: Math.min(b, d), width: Math.abs(c - a), height: Math.abs(d - b),
                  background: colors[m.color] ?? colors.yellow }} />;
            }))}
          </div>
        </div>
      ))}
      </div>
    </div>
  );
}
