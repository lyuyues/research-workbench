import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Markdown, Notice, Toolbar, ago, postJson, useJson, when } from "./common";
import { navigate, useSubRoute } from "./route";
import type { PanelProps } from "./common";
import { PdfView, clampZoom } from "./PdfView";
import type { Mark, OutlineItem, Selection } from "./PdfView";

type Status = "to-read" | "reading" | "done" | "dropped";
interface Zot { state: "off" | "queued" | "pending" | "synced" | "error"; key: string | null; attachment_key: string | null;
  synced_at: number | null; error: string | null; bridge_state: string | null }
export interface Paper { id: string; title: string; authors: string[]; year: string; venue: string; doi: string; arxiv: string;
  url: string; pdf_url: string; source: string; added: number; status: Status; zotero_want: boolean; notes: string; pdf: string;
  pdf_state: "ok" | "failed" | "downloading" | "waiting-mac"; pdf_error: string | null; highlights: number;
  notes_exists: boolean; zotero: Zot; tags?: string[]; rating?: number }
interface Library { papers: Paper[]; zotero_configured: boolean; bridge_updated: number | null; index_updated: number | null;
  collection: string | null; colors: Record<string, string> }
interface Highlight { id: string; page: number; rects: number[][]; top: number; text: string; comment: string; color: string;
  zotero_key?: string; zotero_error?: string }
interface ZHighlight { key: string; type: string; page: number; rects: number[][]; top: number; text: string; comment: string; color: string }
interface Detail { paper: Paper; highlights: Highlight[]; zotero_highlights: ZHighlight[];
  notes: { path: string; text: string; exists: boolean; mtime: number | null }; colors: Record<string, string>;
  ocr?: { state: "running" | "done" | "skipped" | "error"; done: number; total: number; updated?: number; error?: string } | null }
interface ZItem { key: string; title: string; creators: string[]; year: string; venue: string; doi: string; url: string;
  collections: string[]; pdf_key: string | null; in_list: boolean }

const TABS: [Status | "all", string][] = [["reading", "Reading"], ["to-read", "To read"], ["done", "Done"], ["all", "All"]];
type Kind = "papers" | "books";
const BOOK_TAG = "book";
const KINDS: [Kind, string][] = [["papers", "Papers"], ["books", "Books"]];
const isBook = (p: { tags?: string[] }) => (p.tags ?? []).includes(BOOK_TAG);
const STATUS_LABEL: Record<Status, string> = { "to-read": "To read", reading: "Reading", done: "Done", dropped: "Dropped" };
const PDF_LABEL: Record<Paper["pdf_state"], string> = { ok: "PDF", failed: "No PDF", downloading: "Fetching PDF…",
  "waiting-mac": "PDF coming from Zotero (Mac)…" };
const Z_LABEL: Record<Zot["state"], string> = { off: "Not in Zotero", queued: "Adding to Zotero (Mac)…", pending: "Zotero: syncing…",
  synced: "Zotero ✓", error: "Zotero: error" };
const HL_START = "<!-- highlights:start";
const HL_END = "<!-- highlights:end -->";
const ZNOTES = "<!-- zotero-notes";
/** Notes written in Zotero, pulled into the generated block (read-only here). */
export const zoteroNotes = (t: string) => {
  const a = t.indexOf(ZNOTES), b = t.indexOf(HL_END);
  if (a === -1 || b < a) return "";
  return t.slice(t.indexOf("\n", a) + 1, b).replace(/^## From Zotero\s*/, "").trim();
};

/** Other panels ("Read" buttons) add a paper and jump straight to it (#/reading/<id>). */
export async function addToReading(meta: Record<string, unknown>): Promise<string> {
  try {
    const r = await fetch("/api/reading/add", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(meta) });
    const j = await r.json().catch(() => null) as { id?: string; detail?: unknown } | null;
    if (!r.ok || !j?.id) return typeof j?.detail === "string" ? j.detail : `HTTP ${r.status}`;
    navigate("reading", [j.id]);
    return "";
  } catch (e) {
    return `network error: ${String(e)}`;
  }
}

const stripBlock = (t: string) => {
  const a = t.indexOf(HL_START), b = t.indexOf(HL_END);
  return a !== -1 && b > a ? (t.slice(0, a) + t.slice(b + HL_END.length)).trimEnd() + "\n" : t;
};
const cite = (p: Paper) => [p.authors.slice(0, 3).join(", ") + (p.authors.length > 3 ? " et al." : ""), p.year, p.venue].filter(Boolean).join(" · ");
const card = (p: Paper) => `Paper: ${p.title}\n${cite(p)}\nPDF: ${p.pdf}\nNotes file: ${p.notes}\n${p.doi ? `DOI: ${p.doi}\n` : ""}${p.url}`;

export const READ_PROMPTS = {
  full: (p: Paper) => `Read ${p.pdf} and write my reading notes for "${p.title}" in ${p.notes} following ` +
    `documents/workflow/paper_reading_template.md. Keep my "## My notes" text and the highlights block as they are; use my ` +
    `highlights and comments as anchors; mark your answers to the three questions "> [AI draft, to revise]". Link the notes from the ` +
    `weekly digest if the paper is in one.`,
  save: (p: Paper) => `Add the key points of our discussion about "${p.title}" to ${p.notes} under "## My notes" as 🤖 bullets ` +
    `(keep my text, don't touch the highlights block). Tell me what you added.`,
};

function AddForm({ onAdded, onError }: { onAdded: (id: string) => void; onError: (m: string) => void }) {
  const [title, setTitle] = useState("");
  const [link, setLink] = useState("");
  const [zotero, setZotero] = useState(true);
  const add = async () => {
    const isPdf = /\.pdf($|\?)/i.test(link);
    const err = await postJson("/api/reading/add", { title, url: isPdf ? "" : link, pdf_url: isPdf ? link : "",
      doi: /^10\.\d+\//.test(link) ? link : "", arxiv: /^\d{4}\.\d{4,5}$/.test(link) ? link : "", source: "manual", zotero });
    if (err) onError(err); else { setTitle(""); setLink(""); onAdded(""); }
  };
  return (
    <section className="card">
      <h3>Add a paper</h3>
      <div className="reply">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="Title" style={{ flex: 2 }} />
        <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="arXiv id, DOI, page or PDF link" aria-label="Link" style={{ flex: 2 }} />
        <label className="small"><input type="checkbox" checked={zotero} onChange={(e) => setZotero(e.target.checked)} /> add to Zotero</label>
        <button onClick={add} disabled={!title.trim()}>Add</button>
      </div>
    </section>
  );
}

function ZoteroSearch({ lib, onOpen, onError }: { lib: Library; onOpen: (id: string) => void; onError: (m: string) => void }) {
  const [q, setQ] = useState("");
  const [term, setTerm] = useState<string | null>(null);
  const res = useJson<{ items: ZItem[] }>(term ? `/api/reading/zotero-search?q=${encodeURIComponent(term)}` : null);
  const open = async (it: ZItem) => {
    const r = await fetch("/api/reading/add", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: it.title, authors: it.creators, year: it.year, venue: it.venue, doi: it.doi, url: it.url,
        zotero_key: it.key, zotero_attachment: it.pdf_key, source: "zotero" }) });
    const j = await r.json().catch(() => null) as { id?: string; detail?: string } | null;
    if (j?.id) onOpen(j.id); else onError(j?.detail ?? `HTTP ${r.status}`);
  };
  return (
    <section className="card">
      <h3>Open from my Zotero library</h3>
      {!lib.index_updated && <p className="muted small">The Zotero index has not arrived from the Mac yet (tools/zotero_bridge.py, every 10 min).</p>}
      <div className="reply">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, author, year, collection…" aria-label="Search Zotero"
          onKeyDown={(e) => { if (e.key === "Enter" && q.trim()) setTerm(q.trim()); }} style={{ flex: 1 }} />
        <button onClick={() => setTerm(q.trim())} disabled={!q.trim()}>Search</button>
      </div>
      {lib.index_updated && <p className="muted small">Index from the Mac · {when(lib.index_updated)}</p>}
      {res.data && res.data.items.length === 0 && <p className="muted small">No match.</p>}
      <ul className="filelist">
        {res.data?.items.map((it) => (
          <li key={it.key}>
            <button className="linkish" onClick={() => open(it)}>{it.title}</button>
            <span className="muted small"> · {it.creators.slice(0, 2).join(", ")} {it.year}{it.pdf_key ? "" : " · no PDF"}{it.in_list ? " · in list" : ""}
              {it.collections.length ? ` · ${it.collections[0]}` : ""}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface AudioStatus { state: "none" | "writing" | "speaking" | "done" | "error"; error?: string;
  episode?: { n: number; duration: number; bytes: number; generated?: string } }
const AUDIO_LABEL = { writing: "Writing the brief…", speaking: "Recording…" } as const;

/** 🎧 On-demand English audio brief: Claude writes a ~10 min script from the PDF, Edge TTS reads it.
 *  The mp3 also lands in the private podcast feed ("Paper briefs"). */
export function PaperAudio({ id, hasPdf }: { id: string; hasPdf: boolean }) {
  const [s, setS] = useState<AudioStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = async (init?: RequestInit) => {
    try {
      const r = await fetch(`/api/reading/paper/${id}/audio`, init);
      const j = await r.json().catch(() => null) as (AudioStatus & { detail?: unknown }) | null;
      if (!r.ok || !j) { setErr(typeof j?.detail === "string" ? j.detail : `HTTP ${r.status}`); return; }
      setErr(null); setS(j);
    } catch (e) { setErr(String(e)); }
  };
  useEffect(() => { setS(null); void load(); }, [id]);
  const busy = s?.state === "writing" || s?.state === "speaking";
  useEffect(() => {
    if (!busy) return;
    const t = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(t);
  }, [busy, id]);
  if (!s && !err) return null;
  const make = () => void load({ method: "POST" });
  const ep = s?.episode;
  return (
    <span className="paper-audio">
      {busy && <span className="small muted">🎧 {AUDIO_LABEL[s.state as keyof typeof AUDIO_LABEL]} (~3–5 min)</span>}
      {!busy && ep && <>
        <audio controls preload="none" src={`/api/reading/paper/${id}/audio.mp3?v=${encodeURIComponent(ep.generated ?? "")}`}
          aria-label="English audio brief" />
        <span className="small muted">{Math.round(ep.duration / 60)} min</span>
        <button className="small" onClick={make} title="Write and record the brief again">↻</button>
      </>}
      {!busy && !ep && <button onClick={make} disabled={!hasPdf}
        title={hasPdf ? "Claude writes a ~10 min English brief of this paper and records it" : "Needs the PDF"}>🎧 English audio</button>}
      {(err || s?.state === "error") && <span className="small error">{err ?? s?.error}</span>}
    </span>
  );
}

/** 1-5 stars; clicking the current rating clears it. */
export function Stars({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const [hover, setHover] = useState(0);
  const shown = hover || value;
  return (
    <span className="stars" role="radiogroup" aria-label="Rating" onMouseLeave={() => setHover(0)}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n} star${n > 1 ? "s" : ""}`}
          title={value === n ? "Click again to clear" : `${n} star${n > 1 ? "s" : ""}`}
          className={n <= shown ? "on" : ""} onMouseEnter={() => setHover(n)} onClick={() => onChange(value === n ? 0 : n)}>★</button>
      ))}
    </span>
  );
}

/** Tag chips with ✕, plus an inline "+ tag" input that suggests tags already used elsewhere. */
export function Tags({ tags, all, onChange }: { tags: string[]; all: string[]; onChange: (t: string[]) => void }) {
  const [txt, setTxt] = useState<string | null>(null);
  const add = () => {
    const t = (txt ?? "").trim().replace(/^#/, "");
    if (t && !tags.some((x) => x.toLowerCase() === t.toLowerCase())) onChange([...tags, t]);
    setTxt(null);
  };
  const listId = "tag-suggest";
  return (
    <span className="tags">
      {tags.map((t) => (
        <span key={t} className="tag">{t}<button type="button" className="tag-x" aria-label={`Remove tag ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))}>×</button></span>
      ))}
      {txt === null ? <button type="button" className="linkish small" onClick={() => setTxt("")}>+ tag</button> : (
        <>
          <input className="tag-input" autoFocus value={txt} list={listId} aria-label="New tag" placeholder="tag"
            onChange={(e) => setTxt(e.target.value)} onBlur={add}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } else if (e.key === "Escape") setTxt(null); }} />
          <datalist id={listId}>{all.filter((a) => !tags.includes(a)).map((a) => <option key={a} value={a} />)}</datalist>
        </>
      )}
    </span>
  );
}

function PaperCard({ p, allTags, onOpen, onChanged, onError }: { p: Paper; allTags: string[]; onOpen: () => void; onChanged: () => void; onError: (m: string) => void }) {
  const [link, setLink] = useState<string | null>(null);
  const set = async (body: Record<string, unknown>) => {
    const err = await postJson(`/api/reading/paper/${p.id}`, body);
    if (err) onError(err);
    onChanged();
  };
  return (
    <article className={`card paper reading-card s-${p.status}`}>
      <div className="card-head"><button className="linkish paper-title" onClick={onOpen}>{p.title}</button></div>
      <div className="small muted">{cite(p)}</div>
      <div className="small">
        <span className={`status ${p.pdf_state === "ok" ? "s-ok" : p.pdf_state === "failed" ? "s-stale" : ""}`} title={p.pdf_error ?? ""}>{PDF_LABEL[p.pdf_state]}</span>{" "}
        <span className={`status ${p.zotero.state === "synced" ? "s-ok" : p.zotero.state === "error" ? "s-stale" : ""}`}
          title={p.zotero.error ?? p.zotero.bridge_state ?? ""}>{Z_LABEL[p.zotero.state]}</span>
        {p.highlights > 0 && <span className="muted"> · {p.highlights} highlight{p.highlights > 1 ? "s" : ""}</span>}
        <span className="muted"> · {p.source} · added {ago(p.added)}</span>
      </div>
      <div className="small paper-meta">
        <Stars value={p.rating ?? 0} onChange={(n) => set({ rating: n })} />
        <Tags tags={p.tags ?? []} all={allTags} onChange={(t) => set({ tags: t })} />
      </div>
      {p.pdf_state === "failed" && p.pdf_error && <p className="small error">{p.pdf_error}</p>}
      <div className="paper-actions">
        <button onClick={onOpen}>Open</button>
        <select value={p.status} aria-label="Status" onChange={(e) => set({ status: e.target.value })}>
          {Object.entries(STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        {p.zotero.state === "off" && <button className="linkish" onClick={() => set({ zotero: true })}>Add to Zotero</button>}
        {p.pdf_state === "failed" && link === null && <button className="linkish" onClick={() => setLink("")}>Give a PDF link</button>}
      </div>
      {link !== null && (
        <div className="reply">
          <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…/paper.pdf" aria-label="PDF link" style={{ flex: 1 }} />
          <button disabled={!/^https?:\/\//.test(link)} onClick={async () => { await set({ pdf_url: link }); setLink(null); }}>Fetch</button>
          <button className="linkish" onClick={() => setLink(null)}>Cancel</button>
        </div>
      )}
    </article>
  );
}

function TocNode({ x, depth, active, onGo }: { x: OutlineItem; depth: number; active: OutlineItem | null; onGo: (o: OutlineItem) => void }) {
  const holds = (y: OutlineItem): boolean => y === active || y.items.some(holds);
  const [open, setOpen] = useState(() => depth < 1 || holds(x));
  return (
    <li>
      <div className={`toc-row${x === active ? " active" : ""}`}>
        {x.items.length > 0
          ? <button className="toc-twist" onClick={() => setOpen((o) => !o)} aria-label={open ? "Collapse" : "Expand"} aria-expanded={open}>{open ? "▾" : "▸"}</button>
          : <span className="toc-twist" aria-hidden="true" />}
        <button className="toc-link" disabled={x.page === null} onClick={() => onGo(x)} title={x.title}
          aria-current={x === active ? "location" : undefined}>{x.title}</button>
        {x.page !== null && <span className="toc-page">{x.page + 1}</span>}
      </div>
      {open && x.items.length > 0 && <ul>{x.items.map((c, i) => <TocNode key={i} x={c} depth={depth + 1} active={active} onGo={onGo} />)}</ul>}
    </li>
  );
}

/** Left panel: the PDF's own table of contents; the section you are reading is highlighted. */
export function Outline({ items, current, onGo }: { items: OutlineItem[]; current: number; onGo: (o: OutlineItem) => void }) {
  const flat = useMemo(() => {
    const out: OutlineItem[] = [];
    const walk = (xs: OutlineItem[]) => xs.forEach((x) => { out.push(x); walk(x.items); });
    walk(items);
    return out;
  }, [items]);
  // the last entry (in reading order) that starts at or before the current page
  const active = useMemo(() => {
    let best: OutlineItem | null = null;
    for (const x of flat) if (x.page !== null && x.page <= current && (!best || x.page >= best.page!)) best = x;
    return best;
  }, [flat, current]);
  return <ul className="toc-tree">{items.map((x, i) => <TocNode key={i} x={x} depth={0} active={active} onGo={onGo} />)}</ul>;
}

function Reader({ id, onBack, onAsk: ask, onPrompt: prompt, onError }: { id: string; onBack: () => void; onError: (m: string) => void } & PanelProps) {
  const d = useJson<Detail>(`/api/reading/paper/${id}`);
  // Full screen: the reader covers the whole app (and the browser goes full screen when it allows it).
  // Anything that talks to the agent leaves full screen first so the agent pane is visible.
  const [full, setFull] = useState(false);
  // Side panel (Highlights / Notes / Zotero) can be collapsed in both modes; remembered per browser.
  const [side, setSideRaw] = useState(() => { try { return localStorage.getItem("rp:reader-side") !== "0"; } catch { return true; } });
  const setSide = (f: (x: boolean) => boolean) => setSideRaw((x) => {
    const v = f(x);
    try { localStorage.setItem("rp:reader-side", v ? "1" : "0"); } catch { /* ignore */ }
    return v;
  });
  // Left panel: table of contents (the PDF's bookmarks); open/closed remembered per browser.
  const [toc, setTocRaw] = useState(() => { try { return localStorage.getItem("rp:reader-toc") !== "0"; } catch { return true; } });
  const setToc = (v: boolean) => { setTocRaw(v); try { localStorage.setItem("rp:reader-toc", v ? "1" : "0"); } catch { /* ignore */ } };
  const [outline, setOutline] = useState<OutlineItem[] | null>(null);
  const [curPage, setCurPage] = useState(0);
  const [goTo, setGoTo] = useState("");
  // Side panel width: drag its left edge (double-click resets); remembered per browser.
  const [sideW, setSideW] = useState(() => { try { return Number(localStorage.getItem("rp:reader-side-w")) || 340; } catch { return 340; } });
  const bodyRef = useRef<HTMLDivElement>(null);
  const saveSideW = (w: number) => {
    const max = Math.max(260, (bodyRef.current?.clientWidth ?? window.innerWidth) - 320);
    const c = Math.round(Math.min(Math.max(w, 240), max));
    setSideW(c);
    try { localStorage.setItem("rp:reader-side-w", String(c)); } catch { /* ignore */ }
  };
  const resizeDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX, w0 = sideW, el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => saveSideW(w0 + (x0 - ev.clientX));
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up); };
    el.addEventListener("pointermove", move); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
  };
  // In full screen the toolbar hides; hovering the top edge for 1 s brings it back.
  const [bar, setBar] = useState(false);
  const barTimer = useRef<number | undefined>(undefined);
  const peek = () => { window.clearTimeout(barTimer.current); barTimer.current = window.setTimeout(() => setBar(true), 1000); };
  const unpeek = () => window.clearTimeout(barTimer.current);
  useEffect(() => { if (!full) { setBar(false); window.clearTimeout(barTimer.current); } }, [full]);
  // Resolves once the browser has really left full screen: Chrome swallows a history Back made while
  // the tab is still full screen (it only exits full screen), so navigation must wait for this.
  const exitFull = (): Promise<void> => {
    setFull(false);
    if (!document.fullscreenElement) return Promise.resolve();
    return document.exitFullscreen().catch(() => undefined);
  };
  const enterFull = () => {
    setFull(true);
    void document.documentElement.requestFullscreen?.().catch(() => undefined);
  };
  useEffect(() => {
    if (!full) return;
    const onChange = () => { if (!document.fullscreenElement) setFull(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.fullscreenElement) setFull(false); };
    document.addEventListener("fullscreenchange", onChange);
    window.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("fullscreenchange", onChange); window.removeEventListener("keydown", onKey); };
  }, [full]);
  useEffect(() => () => { if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined); }, []);
  const onAsk: typeof ask = (label, text) => { exitFull(); ask(label, text); };
  const onPrompt: typeof prompt = (text) => { exitFull(); prompt(text); };
  const [zoom, setZoom] = useState(1);
  const [sel, setSel] = useState<Selection | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [jump, setJump] = useState<{ page: number; top?: number; n: number } | null>(null);
  // Reading position, shared with Zotero (desktop / iPad) through its synced "last page" setting:
  // open where you left off (on either side), and save the page ~2 s after scrolling stops.
  const savedPage = useRef<number | null>(null);
  const posTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    let live = true;
    savedPage.current = null;
    void fetch(`/api/reading/paper/${id}/position`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
      .then((j: { page: number | null } | null) => {
        if (!live) return;
        savedPage.current = j?.page ?? 0;
        if (j?.page) { setJump({ page: j.page, n: 1 }); setCurPage(j.page); }
      });
    return () => { live = false; window.clearTimeout(posTimer.current); };
  }, [id]);
  const onPage = (page: number) => {
    setCurPage(page);
    curRef.current = page;
    if (savedPage.current === null) return;   // position not loaded yet: don't overwrite it with page 1
    window.clearTimeout(posTimer.current);
    posTimer.current = window.setTimeout(() => {
      if (page === savedPage.current) return;
      savedPage.current = page;
      void postJson(`/api/reading/paper/${id}/position`, { page });
    }, 2000);
  };
  const [tab, setTab] = useState<"highlights" | "notes" | "zotero">("highlights");
  const [editing, setEditing] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [notes, setNotes] = useState<{ base: string; text: string } | null>(null);
  const [preview, setPreview] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const v = d.data;
  const colors = v?.colors ?? {};
  const ocr = v?.ocr ?? null;
  useEffect(() => {   // scanned PDF: poll until the OCR text layer is ready, then the PDF reloads (new ?v=)
    if (ocr?.state !== "running") return;
    const t = window.setInterval(() => d.reload(), 5000);
    return () => window.clearInterval(t);
  }, [ocr?.state, d.reload]);
  // the PDF reloads with its new text layer: go back to the page being read
  const ocrDone = ocr?.state === "done" ? ocr.updated : undefined;
  const firstOcr = useRef(ocrDone);
  const curRef = useRef(0);
  useEffect(() => {
    if (ocrDone === firstOcr.current) return;
    firstOcr.current = ocrDone;
    if (curRef.current > 0) setJump({ page: curRef.current, n: Date.now() });
  }, [ocrDone]);
  useEffect(() => {
    if (v && !notes) setNotes({ base: v.notes.text, text: stripBlock(v.notes.text) });
  }, [v, notes]);
  useEffect(() => {
    if (v?.paper.status === "to-read") void postJson(`/api/reading/paper/${id}`, { status: "reading" });
  }, [v?.paper.status, id]);

  const marks: Mark[] = useMemo(() => [
    ...(v?.highlights ?? []).map((h) => ({ id: h.id, page: h.page, rects: h.rects, color: h.color })),
    ...(v?.zotero_highlights ?? []).map((h) => ({ id: `z:${h.key}`, page: h.page, rects: h.rects, color: h.color, zotero: true })),
  ], [v]);

  if (d.error) return <p className="error">{d.error}</p>;
  if (!v) return <p className="muted">Loading…</p>;
  const p = v.paper;
  const passage = (page: number, text: string, extra = "") =>
    onAsk(`p.${page + 1} “${text.slice(0, 40)}${text.length > 40 ? "…" : ""}”`,
      `${card(p)}\nPassage (page ${page + 1} of the PDF): "${text}"${extra}`);

  const highlight = async (color: string, withNote = false) => {
    if (!sel) return;
    const r = await fetch(`/api/reading/paper/${id}/highlights`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page: sel.page, rects: sel.rects, top: sel.top, page_height: sel.page_height, text: sel.text, color }) });
    if (!r.ok) { onError(`Could not save the highlight (HTTP ${r.status})`); return; }
    const h = await r.json() as Highlight;
    window.getSelection()?.removeAllRanges();
    setSel(null);
    d.reload();
    if (withNote) { setTab("highlights"); setEditing(h.id); setComment(""); }
  };
  const editHl = async (hid: string, body: Record<string, unknown>) => {
    const err = await postJson(`/api/reading/paper/${id}/highlights/${hid}`, body);
    if (err) onError(err);
    d.reload();
  };
  const saveNotes = async () => {
    if (!notes) return;
    const err = await postJson(`/api/reading/paper/${id}/notes`, { text: notes.text, expect: notes.base });
    if (err) { onError(err); return; }
    setNotes(null);
    d.reload();
  };
  const reloadNotes = () => { setNotes(null); d.reload(); };
  const syncNow = async () => {
    setSyncMsg("Syncing…");
    const r = await fetch(`/api/reading/paper/${id}/sync`, { method: "POST" });
    const j = await r.json().catch(() => null) as Record<string, unknown> | null;
    setSyncMsg(!r.ok ? String(j?.detail ?? `HTTP ${r.status}`) : j?.waiting ? `Waiting: ${String(j.waiting)}`
      : `Done · note ${String(j?.note ?? "—")} · ${String(j?.pushed ?? 0)} highlights added`);
    d.reload();
  };
  const hls = [...v.highlights].sort((a, b) => a.page - b.page || b.top - a.top);
  const dirty = notes && notes.text !== stripBlock(notes.base);

  return (
    <div className={`reader${full ? " full" : ""}${!side ? " noside" : ""}${toc ? " toc" : ""}${full && bar ? " bar-on" : ""}`}>
      {/* Mouse: hover the top edge 1 s. Touch: tap the top edge (no hover on phones). */}
      {full && <div className="reader-peek" onMouseEnter={peek} onMouseLeave={unpeek} onClick={() => setBar(true)} aria-hidden="true" />}
      <div className="toolbar reader-bar" onMouseLeave={() => { if (full) setBar(false); }}
        onFocus={() => { if (full) setBar(true); }}>
        {/* In full screen "Exit" sits at the far left, away from Chrome's own exit (×) that drops in at the top centre. */}
        {full && <button className="reader-exit" onClick={() => void exitFull()} title="Exit full screen (Esc)">✕ Exit full screen</button>}
        <button onClick={() => { void exitFull().then(onBack); }}>← Reading list</button>
        <button onClick={() => setToc(!toc)} aria-pressed={toc} title={toc ? "Hide the contents" : "Show the contents"}>☰ Contents</button>
        <b className="reader-title" title={p.title}>{p.title}</b>
        <Stars value={p.rating ?? 0} onChange={async (n) => { const e = await postJson(`/api/reading/paper/${p.id}`, { rating: n }); if (e) onError(e); d.reload(); }} />
        <button onClick={() => setZoom((z) => clampZoom(z - 0.15))} aria-label="Zoom out">−</button>
        <span className="small muted">{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom((z) => clampZoom(z + 0.15))} aria-label="Zoom in">+</button>
        <button className="ask" onClick={() => onAsk(`Paper: ${p.title.slice(0, 50)}`, card(p))}>Ask about this paper</button>
        <button className="quick" onClick={() => onPrompt(READ_PROMPTS.full(p))}>Full notes (template)</button>
        <button className="quick" onClick={() => onPrompt(READ_PROMPTS.save(p))}>Save discussion → notes</button>
        <PaperAudio id={id} hasPdf={p.pdf_state === "ok"} />
        {p.url && <a className="small" href={p.url} target="_blank" rel="noreferrer">source</a>}
        <button onClick={() => setSide((x) => !x)} aria-pressed={side} title={side ? "Hide the highlights / notes panel" : "Show the highlights / notes panel"}>
          {side ? "Hide panel »" : "« Show panel"}</button>
        {!full && <button onClick={enterFull} title="Read in full screen">⛶ Full screen</button>}
      </div>
      <div className="reader-body" ref={bodyRef} style={{ "--side-w": `${sideW}px` } as React.CSSProperties}>
        {toc && (
          <aside className="reader-toc" aria-label="Contents">
            <div className="toc-head">
              <b>Contents</b>
              <input className="toc-goto" value={goTo} inputMode="numeric" placeholder="page" aria-label="Go to page"
                onChange={(e) => setGoTo(e.target.value.replace(/\D/g, ""))}
                onKeyDown={(e) => { if (e.key === "Enter" && Number(goTo) > 0) { setJump({ page: Number(goTo) - 1, n: Date.now() }); setGoTo(""); } }} />
              <button className="side-hide" onClick={() => setToc(false)} title="Hide contents" aria-label="Hide contents">«</button>
            </div>
            {outline === null ? <p className="muted small">Loading…</p>
              : outline.length === 0 ? <p className="muted small">This PDF has no table of contents (no bookmarks). Type a page number above to jump.</p>
              : <Outline items={outline} current={curPage} onGo={(o) => { if (o.page !== null) setJump({ page: o.page, top: o.top, n: Date.now() }); }} />}
          </aside>
        )}
        {!toc && <button className="toc-tab" onClick={() => setToc(true)} title="Show contents" aria-label="Show contents">»</button>}
        <div className="pdf-wrap" onScroll={() => setSel(null)}
          onPointerDown={(e) => { if (full && bar && e.pointerType === "touch") setBar(false); }}>
          {ocr?.state === "running" && (
            <p className="ocr-note small" role="status">Scanned PDF — making the text selectable (OCR){ocr.total ? ` · ${ocr.done} / ${ocr.total} pages` : "…"}.
              You can read meanwhile; highlighting works once this finishes and the page reloads.</p>)}
          {ocr?.state === "error" && <p className="ocr-note small error">OCR failed: {ocr.error}</p>}
          {p.pdf_state === "ok"
            ? <PdfView onPage={onPage} onOutline={setOutline}
                url={`/api/reading/paper/${id}/pdf${ocr?.state === "done" && ocr.updated ? `?v=${ocr.updated}` : ""}`} zoom={zoom} marks={marks} colors={colors} active={active} jump={jump}
                onZoom={(z) => { setSel(null); setZoom(z); }} onSelect={setSel} onMarkClick={(mid) => { setActive(mid); setTab("highlights"); }} />
            : <p className="muted">{PDF_LABEL[p.pdf_state]} {p.pdf_error && <span className="error">{p.pdf_error}</span>}</p>}
          {sel && (
            <div className="sel-pop" style={{ left: Math.max(4, sel.x), top: sel.y }} onMouseUp={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}>
              {Object.entries(colors).map(([c, hex]) => (
                <button key={c} className="swatch" style={{ background: hex }} aria-label={`Highlight ${c}`} title={`Highlight (${c})`}
                  onClick={() => highlight(c)} />
              ))}
              <button onClick={() => highlight("yellow", true)}>+ note</button>
              <button className="ask" onClick={() => { passage(sel.page, sel.text); setSel(null); }}>Ask agent</button>
            </div>
          )}
        </div>
        {!side && <button className="side-tab" onClick={() => setSide(() => true)} title="Show highlights / notes" aria-label="Show side panel">«</button>}
        {side && <div className="side-resize" role="separator" aria-orientation="vertical" aria-label="Resize side panel" tabIndex={0}
            aria-valuenow={sideW} title="Drag to resize · double-click to reset"
            onPointerDown={resizeDown} onDoubleClick={() => saveSideW(340)}
            onKeyDown={(e) => { if (e.key === "ArrowLeft") saveSideW(sideW + 24); else if (e.key === "ArrowRight") saveSideW(sideW - 24); }} />}
        <aside className="reader-side">
          <div className="subnav sub2" role="tablist">
            <button className="side-hide" onClick={() => setSide(() => false)} title="Hide panel" aria-label="Hide side panel">»</button>
            {(["highlights", "notes", "zotero"] as const).map((t) => (
              <button key={t} role="tab" aria-selected={t === tab} className={t === tab ? "active" : ""} onClick={() => setTab(t)}>
                {t === "highlights" ? `Highlights ${v.highlights.length + v.zotero_highlights.length}` : t === "notes" ? `Notes${dirty ? " •" : ""}` : "Zotero"}</button>
            ))}
          </div>

          {tab === "highlights" && (
            <div className="hl-list">
              {hls.length === 0 && v.zotero_highlights.length === 0 && <p className="muted small">Select text in the PDF to highlight it, add a note, or ask the agent about it.</p>}
              {hls.map((h) => (
                <div key={h.id} className={`hl${h.id === active ? " active" : ""}`} style={{ borderLeftColor: colors[h.color] }}>
                  <button className="linkish small" onClick={() => { setActive(h.id); setJump({ page: h.page, top: h.top, n: Date.now() }); }}>
                    p.{h.page + 1}</button>
                  <span className="small hl-text">{h.text}</span>
                  {editing === h.id ? (
                    <div className="reply">
                      <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} aria-label="Highlight note" autoFocus />
                      <button onClick={async () => { await editHl(h.id, { comment }); setEditing(null); }}>Save</button>
                      <button className="linkish" onClick={() => setEditing(null)}>Cancel</button>
                    </div>
                  ) : h.comment && <p className="small hl-comment">{h.comment}</p>}
                  <div className="hl-actions small">
                    {Object.entries(colors).map(([c, hex]) => c !== h.color && (
                      <button key={c} className="swatch tiny" style={{ background: hex }} aria-label={`Colour ${c}`} onClick={() => editHl(h.id, { color: c })} />))}
                    <button className="linkish" onClick={() => { setEditing(h.id); setComment(h.comment); }}>{h.comment ? "Edit note" : "Add note"}</button>
                    <button className="linkish" onClick={() => passage(h.page, h.text, h.comment ? `\nMy note on it: ${h.comment}` : "")}>Ask agent</button>
                    <button className="linkish" onClick={() => editHl(h.id, { delete: true })}>Delete</button>
                    {h.zotero_key && <span className="muted" title="Also in Zotero">Z✓</span>}
                    {h.zotero_error && <span className="error" title={h.zotero_error}>Z!</span>}
                  </div>
                </div>
              ))}
              {v.zotero_highlights.length > 0 && <h3 className="small">From Zotero (Mac / iPad)</h3>}
              {v.zotero_highlights.map((h) => (
                <div key={h.key} className={`hl zotero${`z:${h.key}` === active ? " active" : ""}`} style={{ borderLeftColor: colors[h.color] }}>
                  <button className="linkish small" onClick={() => { setActive(`z:${h.key}`); setJump({ page: h.page, top: h.top, n: Date.now() }); }}>p.{h.page + 1}</button>
                  <span className="small hl-text">{h.text || `(${h.type})`}</span>
                  {h.comment && <p className="small hl-comment">{h.comment}</p>}
                  <div className="hl-actions small">
                    <button className="linkish" onClick={() => passage(h.page, h.text, h.comment ? `\nMy note on it: ${h.comment}` : "")}>Ask agent</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === "notes" && notes && (
            <div className="notes-edit">
              <p className="muted small">{v.notes.path}{v.notes.mtime ? ` · ${when(v.notes.mtime)}` : " · new"} · the Highlights section is added automatically.</p>
              <div className="toolbar">
                <button onClick={() => setPreview((x) => !x)}>{preview ? "Edit" : "Preview"}</button>
                <button onClick={saveNotes} disabled={!dirty}>Save notes</button>
                <button onClick={reloadNotes} title="Reload (e.g. after the agent wrote to the notes)">Reload</button>
              </div>
              {preview ? <Markdown text={notes.text} base={v.notes.path} />
                : <textarea className="notes-area" value={notes.text} onChange={(e) => setNotes({ ...notes, text: e.target.value })} aria-label="Notes" />}
              {zoteroNotes(v.notes.text) && (
                <section className="znotes" aria-label="Notes from Zotero">
                  <h4>From Zotero <span className="muted small">· written in Zotero, edit them there</span></h4>
                  <Markdown text={zoteroNotes(v.notes.text)} base={v.notes.path} />
                </section>
              )}
            </div>
          )}

          {tab === "zotero" && (
            <div className="small">
              <p><b>{Z_LABEL[p.zotero.state]}</b>{p.zotero.synced_at ? ` · last sync ${when(p.zotero.synced_at)}` : ""}</p>
              {p.zotero.error && <p className="error">{p.zotero.error}</p>}
              {p.zotero.bridge_state && <p className="muted">Mac bridge: {p.zotero.bridge_state}</p>}
              {p.zotero.key && <p className="muted">Item {p.zotero.key}{p.zotero.attachment_key ? ` · PDF ${p.zotero.attachment_key}` : " · no PDF attachment yet"}</p>}
              <p className="muted">Your notes go to Zotero as a child note; highlights become Zotero highlights on the same PDF; highlights and notes made in Zotero show up here (notes under Notes → From Zotero); the reading position is shared.</p>
              <div className="toolbar">
                {p.zotero.state === "off" && <button onClick={async () => { await postJson(`/api/reading/paper/${id}`, { zotero: true }); d.reload(); }}>Add to Zotero</button>}
                {p.zotero.key && <button onClick={syncNow}>Sync now</button>}
              </div>
              {syncMsg && <p className="muted">{syncMsg}</p>}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

export function Reading({ onAsk, onPrompt }: PanelProps) {
  const lib = useJson<Library>("/api/reading");
  // The open paper is part of the address (#/reading/<id>), so Back returns to the list.
  const [sub, setSub] = useSubRoute("reading");
  const open = sub[0] ?? null;
  const fromList = useRef(false); // opened from this list → "Back to list" is a real browser Back
  const setOpen = (id: string | null) => {
    if (id) { fromList.current = true; setSub([id]); return; }
    if (!fromList.current) { setSub([]); return; }
    fromList.current = false;
    const at = window.location.hash;
    window.history.back();
    // If the browser ignored Back (e.g. still leaving full screen), go to the list directly.
    window.setTimeout(() => { if (window.location.hash === at) setSub([], true); }, 400);
  };
  const [tab, setTab] = useState<Status | "all">("reading");
  const [msg, setMsg] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [minStars, setMinStars] = useState(0);
  const [kind, setKind] = useState<Kind>("papers");
  const d = lib.data;
  useEffect(() => {
    if (!d || open) return;
    const mine = d.papers.filter((p) => isBook(p) === (kind === "books"));
    if (tab === "reading" && !mine.some((p) => p.status === "reading") && mine.length) setTab("to-read");
  }, [d, open, tab, kind]);
  // PDFs download in the background: poll while any is still on its way
  useEffect(() => {
    if (!d?.papers.some((p) => p.pdf_state === "downloading" || p.zotero.state === "queued" || p.pdf_state === "waiting-mac")) return;
    const t = setInterval(lib.reload, 15_000);
    return () => clearInterval(t);
  }, [d, lib.reload]);

  if (open) return <Reader id={open} onBack={() => { setOpen(null); lib.reload(); }} onAsk={onAsk} onPrompt={onPrompt} onError={setMsg} />;
  const ofKind = (d?.papers ?? []).filter((p) => isBook(p) === (kind === "books"));
  const allTags = [...new Set((d?.papers ?? []).flatMap((p) => p.tags ?? []))].sort((a, b) => a.localeCompare(b));
  const kindTags = [...new Set(ofKind.flatMap((p) => p.tags ?? []))].filter((t) => t !== BOOK_TAG).sort((a, b) => a.localeCompare(b));
  // Tag and rating filters apply before the status split, so the status counts match what each tab shows.
  const filtered = ofKind.filter((p) => !tagFilter || (p.tags ?? []).includes(tagFilter))
    .filter((p) => !minStars || (p.rating ?? 0) >= minStars);
  const papers = filtered.filter((p) => (tab === "all" ? p.status !== "dropped" : p.status === tab));
  const pickKind = (k: Kind) => { setKind(k); setTagFilter(null); };

  return (
    <div className="reading">
      <Toolbar reload={lib.reload} onPrompt={onPrompt}>
        <button className={adding ? "active" : ""} onClick={() => setAdding((a) => !a)}>{adding ? "Close" : "Add / find a paper"}</button>
      </Toolbar>
      <Notice msg={msg} onClear={() => setMsg(null)} />
      {lib.error && <p className="error">{lib.error}</p>}
      {d && !d.zotero_configured && (
        <p className="small muted">Zotero is not connected on the server yet (no API key) — reading, highlights and notes work; Zotero sync starts once the key is added.</p>
      )}
      {d && d.bridge_updated && Date.now() - d.bridge_updated > 2 * 3_600_000 && (
        <p className="small error">The Mac bridge last reported {ago(d.bridge_updated)} — is the Mac asleep or Zotero closed?</p>
      )}
      {d && adding && (
        <div className="cards">
          <AddForm onAdded={() => { lib.reload(); setTab("to-read"); }} onError={setMsg} />
          <ZoteroSearch lib={d} onOpen={(id) => setOpen(id)} onError={setMsg} />
        </div>
      )}
      {d && (
        <>
          <div className="subnav sub2" role="tablist" aria-label="Kind">
            {KINDS.map(([k, l]) => {
              const n = d.papers.filter((p) => isBook(p) === (k === "books") && p.status !== "dropped").length;
              return <button key={k} role="tab" aria-selected={k === kind} className={k === kind ? "active" : ""} onClick={() => pickKind(k)}>{l} {n}</button>;
            })}
          </div>
          <div className="subnav sub2" role="tablist" aria-label="Status">
            {TABS.map(([k, l]) => {
              const n = filtered.filter((p) => (k === "all" ? p.status !== "dropped" : p.status === k)).length;
              return <button key={k} role="tab" aria-selected={k === tab} className={k === tab ? "active" : ""} onClick={() => setTab(k)}>{l} {n}</button>;
            })}
          </div>
          {(kindTags.length > 0 || ofKind.some((p) => p.rating)) && (
            <div className="tag-filter small">
              {kindTags.map((t) => (
                <button key={t} className={`tag${t === tagFilter ? " active" : ""}`} aria-pressed={t === tagFilter}
                  onClick={() => setTagFilter((x) => (x === t ? null : t))}>{t}</button>
              ))}
              <select value={minStars} aria-label="Minimum rating" onChange={(e) => setMinStars(Number(e.target.value))}>
                <option value={0}>Any rating</option>
                {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{"★".repeat(n)}{n < 5 ? " & up" : ""}</option>)}
              </select>
              {(tagFilter || minStars > 0) && <button className="linkish" onClick={() => { setTagFilter(null); setMinStars(0); }}>Clear filter</button>}
            </div>
          )}
          {d.papers.length === 0 && <p className="muted">Nothing on the reading list yet. Use “Read” on a paper in Trends or Literature, add one by link, or open one from your Zotero library.</p>}
          <div className="cards">
            {papers.map((p) => <PaperCard key={p.id} p={p} allTags={allTags} onOpen={() => setOpen(p.id)} onChanged={lib.reload} onError={setMsg} />)}
          </div>
        </>
      )}
    </div>
  );
}
