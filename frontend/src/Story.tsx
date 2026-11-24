import { useLayoutEffect, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PanelProps } from "./common";
import { imageToDataUrl } from "./AgentChat";
import { toast } from "./common";
import "./story.css";

/** Story canvas: paper flow on top, D1–D4 (+G1–G7) columns, evidence cards the user drags into them.
 *  Source of truth: Research/<PROJECT>/story/canvas.json (backend/story.py). The agent edits the same file. */

export type Color = "support" | "counter" | "caveat" | "gap" | "reviewer" | "flow" | "plain";
export interface Item {
  id: string; kind: "section" | "card" | "note" | "arrow" | "image"; src?: string;
  x?: number; y?: number; w?: number; h?: number; text?: string; color?: Color; size?: "small" | "large" | "title";
  from?: string; to?: string;
}
interface Canvas { project: string; version: number; title: string; items: Item[]; file: string }

// the quick prompt that asks the agent to review the canvas
const REVIEW_CMD = "Review canvas";
const COLOR_LABEL: [Color, string][] = [
  ["support", "Supports"], ["counter", "Counter / conflict"], ["caveat", "Caveat / to verify"],
  ["gap", "⚠ Gap"], ["reviewer", "❓ Reviewer question"], ["flow", "Paper flow"], ["plain", "Plain"],
];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
/** The few inline marks the canvas uses: **bold**, *italic*, `code`, "- " bullets, line breaks. */
export function richText(t: string): string {
  return t.split("\n").map((line) => {
    const bullet = /^- /.test(line);
    let h = esc(bullet ? line.slice(2) : line)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/\*([^*]+)\*/g, "<i>$1</i>");
    return bullet ? `<span class="sc-li">• ${h}</span>` : h;
  }).join("<br>");
}

type Box = { x: number; y: number; w: number; h: number };
const GAP = 10;
const hits = (a: Box, b: Box) => a.x < b.x + b.w + GAP && b.x < a.x + a.w + GAP && a.y < b.y + b.h + GAP && b.y < a.y + a.h + GAP;
const inside = (o: Box, s: Box) => o.x >= s.x && o.y >= s.y && o.x + o.w <= s.x + s.w && o.y + o.h <= s.y + s.h;

/** After a drop/resize: push overlapped cards down out of the way, then grow any section whose cards
 *  now stick out of it (sections below it move down with their contents). `heightOf` gives the rendered height. */
const NEW_EVIDENCE = "New evidence\n*→ claim? · relevance?*";

export function settle(items: Item[], moved: string[], heightOf: (it: Item) => number, fit: string[] = []): Item[] {
  const box = new Map<string, Box>();
  for (const it of items) if (it.kind !== "arrow") box.set(it.id, { x: it.x ?? 0, y: it.y ?? 0, w: it.w ?? 0, h: heightOf(it) });
  const kind = (id: string) => items.find((i) => i.id === id)!.kind;
  const loose = items.filter((i) => i.kind !== "arrow" && i.kind !== "section").map((i) => i.id);
  const fixed = new Set(moved);
  // 1. cards: whatever a moved card lands on slides down; chains are followed
  const queue = moved.filter((id) => box.has(id) && kind(id) !== "section");
  for (let n = 0; queue.length && n < 2000; n++) {
    const q = box.get(queue.shift()!)!;
    for (const id of loose) {
      if (fixed.has(id)) continue;
      const o = box.get(id)!;
      if (o === q || !hits(q, o)) continue;
      o.y = q.y + q.h + GAP;
      queue.push(id);
    }
  }
  // 2. sections: a card belongs to the section holding its top-left corner; the section grows to fit it
  const secs = items.filter((i) => i.kind === "section").map((i) => i.id);
  for (let pass = 0; pass < 20; pass++) {
    let changed = false;
    for (const sid of secs) {
      if (fixed.has(sid)) continue; // a section the user just moved/resized keeps the size they gave it
      const s = box.get(sid)!;
      let right = s.x + s.w, bottom = s.y + s.h;
      for (const id of loose) {
        const o = box.get(id)!;
        if (o.x < s.x || o.y < s.y || o.x >= s.x + s.w || o.y >= s.y + s.h) continue;
        if (secs.some((t) => t !== sid && inside(box.get(t)!, s) && o.x >= box.get(t)!.x && o.y >= box.get(t)!.y &&
          o.x < box.get(t)!.x + box.get(t)!.w && o.y < box.get(t)!.y + box.get(t)!.h)) continue; // belongs to a nested section
        right = Math.max(right, o.x + o.w + 16); bottom = Math.max(bottom, o.y + o.h + 16);
      }
      // a section a card just left or entered hugs its contents (height only; empty sections keep their size)
      if (pass === 0 && fit.includes(sid) && bottom > s.y) {
        let contentBottom = 0;
        for (const id of loose) {
          const o = box.get(id)!;
          if (o.x >= s.x && o.y >= s.y && o.x < s.x + s.w && o.y < s.y + s.h) contentBottom = Math.max(contentBottom, o.y + o.h + 16);
        }
        if (contentBottom && contentBottom < s.y + s.h) { s.h = Math.max(120, contentBottom - s.y); bottom = s.y + s.h; }
      }
      if (right <= s.x + s.w && bottom <= s.y + s.h) continue;
      const oldBottom = s.y + s.h, dh = bottom - oldBottom;
      s.w = right - s.x; s.h = bottom - s.y; changed = true;
      if (dh <= 0) continue;
      // sections starting below the old bottom edge and sharing columns move down, with their contents
      for (const tid of secs) {
        if (tid === sid) continue;
        const t = box.get(tid)!;
        if (t.y < oldBottom - 1 || t.x >= s.x + s.w || s.x >= t.x + t.w || t.y >= s.y + s.h + GAP) continue;
        const shift = s.y + s.h + GAP - t.y;
        const carried = loose.filter((id) => inside(box.get(id)!, t)).concat(secs.filter((u) => u !== tid && inside(box.get(u)!, t)));
        t.y += shift;
        for (const id of carried) box.get(id)!.y += shift;
      }
    }
    if (!changed) break;
  }
  return items.map((it) => {
    const b = box.get(it.id);
    if (!b) return it;
    const out = { ...it, x: b.x, y: b.y };
    if (it.kind === "section") { out.w = b.w; out.h = b.h; }
    return out.x === it.x && out.y === it.y && out.w === it.w && out.h === it.h ? it : out;
  });
}

/** Items written by hand or by the agent may lack numbers; one NaN would freeze the whole view, so fill defaults. */
export function normalize(items: Item[]): Item[] {
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  return (Array.isArray(items) ? items : []).map((it) => {
    if (it.kind === "arrow") return it;
    const w = num(it.w, it.kind === "section" ? 360 : it.kind === "note" ? 260 : 180);
    const out: Item = { ...it, x: num(it.x, 0), y: num(it.y, 0), w };
    if (it.kind !== "note") out.h = num(it.h, it.kind === "section" ? 300 : 84);
    return out;
  });
}

/** Plain-text summary of a card for the agent. */
export function cardText(it: Item, sections: Item[]): string {
  const cx = (it.x ?? 0) + (it.w ?? 0) / 2, cy = (it.y ?? 0) + (it.h ?? 0) / 2;
  const inside = sections.filter((s) => s.id !== it.id && cx > s.x! && cx < s.x! + s.w! && cy > s.y! && cy < s.y! + s.h!)
    .map((s) => (s.text ?? "").split("\n")[0]);
  if (it.kind === "image") return `[image file: story/images/${it.src}] ${it.text ?? ""}`.trim();
  return `[${it.color ?? it.kind}] ${it.text ?? ""}${inside.length ? `\n(placed in: ${inside.join(" › ")})` : ""}`;
}

let seq = 0;
const newId = (items: Item[]) => {
  const used = new Set(items.map((i) => i.id));
  let id = "";
  do { id = `u${Date.now().toString(36)}${(seq++).toString(36)}`; } while (used.has(id));
  return id;
};

type View = { x: number; y: number; z: number };
const clampZ = (z: number) => Math.min(3, Math.max(0.15, z));
type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

type Drag = { ids: string[]; start: Record<string, { x: number; y: number }>; px: number; py: number; moved: boolean; resize?: boolean };

export function Story({ onAsk, onPrompt }: PanelProps) {
  // projects come from projects.yaml (GET /api/project-list)
  const [projects, setProjects] = useState<string[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [project, setProject] = useState<string>(() => {
    try { return localStorage.getItem("story:project") ?? ""; } catch { return ""; }
  });
  useEffect(() => {
    fetch("/api/project-list").then((r) => r.json()).then((j: { projects: { name: string }[]; error: string | null }) => {
      const names = j.projects.map((p) => p.name);
      setProjects(names); setProjectsError(j.error);
      setProject((cur) => (names.includes(cur) ? cur : names[0] ?? ""));
    }).catch((e) => setProjectsError(String(e)));
  }, []);
  const [canvas, setCanvas] = useState<Canvas | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const editingRef = useRef<string | null>(null);
  editingRef.current = editing;
  const [view, setRawView] = useState<View>({ x: 20, y: 40, z: 0.6 });
  // never let a bad number into the view (it would silently stop every pan / zoom)
  const setView = useCallback((u: View | ((v: View) => View)) => setRawView((v) => {
    const n = typeof u === "function" ? u(v) : u;
    return Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.z) && n.z > 0 ? n : v;
  }), []);
  const zoom = view.z;
  const viewRef = useRef(view);
  viewRef.current = view;
  const [saving, setSaving] = useState(false);
  // Full screen = the browser's full screen for the whole page (so the agent column stays) + the canvas covering the rest.
  const [full, setFull] = useState(false);
  const [withAgent, setWithAgent] = useState(true);
  const savingRef = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const vp = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const live = useRef<Canvas | null>(null);
  live.current = canvas;
  // undo / redo (⌘Z / ⌘⇧Z): snapshots of the last saved items; cleared when someone else changes the canvas
  const committed = useRef<Item[]>([]);
  const undoStack = useRef<Item[][]>([]);
  const redoStack = useRef<Item[][]>([]);
  const [, bumpHistory] = useState(0);
  const resetHistory = (items: Item[]) => { committed.current = items; undoStack.current = []; redoStack.current = []; bumpHistory((n) => n + 1); };

  const load = useCallback(async () => {
    try {
      if (!project) return;
      const r = await fetch(`/api/story/${project}`);
      const j = await r.json();
      if (!r.ok) throw new Error(typeof j?.detail === "string" ? j.detail : `HTTP ${r.status}`);
      j.items = normalize(j.items); setCanvas(j); setError(null); resetHistory(j.items);
    } catch (e) { setError(`Could not load the canvas (${e instanceof Error ? e.message : String(e)})`); }
  }, [project]);
  useEffect(() => { setCanvas(null); setSel(null); setEditing(null); load(); }, [load]);
  useEffect(() => { if (project) try { localStorage.setItem("story:project", project); } catch { /* private mode */ } }, [project]);

  const save = useCallback(async (items: Item[], record = true) => {
    const c = live.current; if (!c) return;
    if (record) {
      undoStack.current = [...undoStack.current.slice(-49), committed.current];
      redoStack.current = [];
    }
    committed.current = items; bumpHistory((n) => n + 1);
    setCanvas({ ...c, items });
    setSaving(true); savingRef.current = true;
    try {
      const r = await fetch(`/api/story/${c.project}`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: c.version, items }) });
      const j = await r.json().catch(() => null);
      if (r.status === 409) { toast(typeof j?.detail === "string" ? j.detail : "Canvas changed elsewhere; reloaded"); await load(); return; }
      if (!r.ok) { toast(`Not saved: ${typeof j?.detail === "string" ? j.detail : `HTTP ${r.status}`}`); return; }
      setCanvas((cur) => (cur && cur.project === j.project ? { ...cur, version: j.version } : cur));
    } catch (e) { toast(`Not saved: ${String(e)}`); }
    finally { setSaving(false); savingRef.current = false; }
  }, [load]);

  const items = canvas?.items ?? [];
  const byId = useMemo(() => Object.fromEntries(items.map((i) => [i.id, i])), [items]);
  const sections = items.filter((i) => i.kind === "section");
  const bounds = useMemo(() => {
    let w = 800, h = 600;
    for (const i of items) if (i.kind !== "arrow") { w = Math.max(w, (i.x ?? 0) + (i.w ?? 0) + 200); h = Math.max(h, (i.y ?? 0) + (i.h ?? 60) + 300); }
    return { w, h };
  }, [items]);
  const content = useMemo(() => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const i of items) if (i.kind !== "arrow") {
      x0 = Math.min(x0, i.x!); y0 = Math.min(y0, i.y! - (i.kind === "section" ? 34 : 0));
      x1 = Math.max(x1, i.x! + i.w!); y1 = Math.max(y1, i.y! + (i.h ?? 60));
    }
    return Number.isFinite(x0) ? { x0, y0, x1, y1 } : { x0: 0, y0: 0, x1: 800, y1: 600 };
  }, [items]);

  // ---- view: pan (drag empty space, two-finger scroll/drag) and zoom (pinch, ctrl/⌘ + wheel), around the pointer
  const zoomAt = useCallback((cx: number, cy: number, nz: number) => setView((v) => {
    const z = clampZ(nz);
    return { z, x: cx - ((cx - v.x) * z) / v.z, y: cy - ((cy - v.y) * z) / v.z };
  }), []);
  const fitTo = useCallback((mode: "all" | "width") => {
    const el = vp.current; if (!el) return;
    const W = el.clientWidth, H = el.clientHeight, cw = content.x1 - content.x0, ch = content.y1 - content.y0;
    const z = clampZ(mode === "width" ? (W - 40) / cw : Math.min((W - 40) / cw, (H - 40) / ch));
    setView({ z, x: (W - cw * z) / 2 - content.x0 * z, y: 20 - content.y0 * z });
  }, [content]);
  const fitted = useRef<string | null>(null);
  useEffect(() => {
    if (canvas && fitted.current !== canvas.project) { fitted.current = canvas.project; fitTo("width"); }
  }, [canvas, fitTo]);
  useEffect(() => {
    const el = vp.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest("textarea")) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(e.clientX - r.left, e.clientY - r.top, viewRef.current.z * Math.exp(-Math.max(-25, Math.min(25, e.deltaY)) * 0.01));
      else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    let g0 = 1; // Safari's trackpad pinch arrives as gesture events
    const gs = (e: Event) => { e.preventDefault(); g0 = viewRef.current.z; };
    const gc = (e: Event) => {
      e.preventDefault();
      const ge = e as Event & { scale: number; clientX: number; clientY: number }, r = el.getBoundingClientRect();
      zoomAt(ge.clientX - r.left, ge.clientY - r.top, g0 * ge.scale);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", gs); el.addEventListener("gesturechange", gc);
    return () => { el.removeEventListener("wheel", onWheel); el.removeEventListener("gesturestart", gs); el.removeEventListener("gesturechange", gc); };
  }, [zoomAt]);

  // ---- real full screen (Fullscreen API), CSS fallback where it is missing
  useEffect(() => {
    const f = () => { const d = document as FsDoc; if (!(d.fullscreenElement ?? d.webkitFullscreenElement)) setFull(false); };
    document.addEventListener("fullscreenchange", f); document.addEventListener("webkitfullscreenchange", f);
    return () => { document.removeEventListener("fullscreenchange", f); document.removeEventListener("webkitfullscreenchange", f); };
  }, []);
  const toggleFull = async () => {
    const d = document as FsDoc;
    if (full) {
      setFull(false);
      if (d.fullscreenElement || d.webkitFullscreenElement) { try { if (d.exitFullscreen) await d.exitFullscreen(); else d.webkitExitFullscreen?.(); } catch { /* already out */ } }
      return;
    }
    setFull(true);
    const el = document.documentElement as FsEl;
    try { if (el.requestFullscreen) await el.requestFullscreen(); else await el.webkitRequestFullscreen?.(); } catch { /* not allowed (iPhone): the canvas still covers the page */ }
  };

  // ---- live: pick up changes made elsewhere (the agent editing canvas.json, another tab) every few seconds
  useEffect(() => {
    const id = window.setInterval(async () => {
      const c = live.current;
      if (!c || document.hidden || savingRef.current || drag.current || pan.current || editingRef.current) return;
      try {
        const r = await fetch(`/api/story/${c.project}`);
        if (!r.ok) return;
        const j = (await r.json()) as Canvas;
        const now = live.current;
        if (now && j.project === now.project && j.version > now.version && !savingRef.current && !drag.current && !editingRef.current) {
          j.items = normalize(j.items); setCanvas(j); resetHistory(j.items);
          toast(`Canvas updated (v${j.version})`);
        }
      } catch { /* offline: try again next tick */ }
    }, 3000);
    return () => window.clearInterval(id);
  }, []);


  // ---- pointers: one on empty space pans, two pinch-zoom (cancelling any item drag), one on an item drags it
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const pan = useRef<{ px: number; py: number; vx: number; vy: number; moved: boolean } | null>(null);
  const pinch = useRef<{ d: number; mx: number; my: number; v: View } | null>(null);
  const rel = (e: React.PointerEvent) => { const r = vp.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const onDownCapture = (e: React.PointerEvent) => {
    pts.current.set(e.pointerId, rel(e));
    if (pts.current.size !== 2) return;
    const d = drag.current;
    if (d) {
      drag.current = null;
      if (d.moved && live.current) setCanvas({ ...live.current, items: live.current.items.map((o) => {
        const s = d.start[o.id]; if (!s) return o;
        return d.resize ? { ...o, w: s.x, ...(o.kind !== "note" ? { h: s.y } : {}) } : { ...o, x: s.x, y: s.y };
      }) });
    }
    pan.current = null;
    const [a, b] = [...pts.current.values()];
    pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, v: viewRef.current };
  };
  const onBgDown = (e: React.PointerEvent) => {
    if (editing || pts.current.size > 1 || (e.pointerType === "mouse" && e.button !== 0)) return;
    pan.current = { px: e.clientX, py: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  // ---- dragging (move / resize). A section carries what lies fully inside it.
  const onDown = (e: React.PointerEvent, it: Item, resize = false) => {
    if (editing || e.button !== 0 || pts.current.size > 1) return;
    e.stopPropagation();
    setSel(it.id);
    let ids = [it.id];
    if (it.kind === "section" && !resize) {
      ids = ids.concat(items.filter((o) => o.id !== it.id && o.kind !== "arrow" &&
        o.x! >= it.x! && o.y! >= it.y! && o.x! + (o.w ?? 0) <= it.x! + it.w! && o.y! + (o.h ?? 20) <= it.y! + it.h!).map((o) => o.id));
    }
    const start: Drag["start"] = {};
    for (const id of ids) start[id] = resize ? { x: byId[id].w!, y: byId[id].h ?? 40 } : { x: byId[id].x!, y: byId[id].y! };
    drag.current = { ids, start, px: e.clientX, py: e.clientY, moved: false, resize };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (pts.current.has(e.pointerId)) pts.current.set(e.pointerId, rel(e));
    const pc = pinch.current;
    if (pc && pts.current.size >= 2) {
      const [a, b] = [...pts.current.values()];
      const z = clampZ((pc.v.z * (Math.hypot(a.x - b.x, a.y - b.y) || 1)) / pc.d), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      setView({ z, x: mx - ((pc.mx - pc.v.x) / pc.v.z) * z, y: my - ((pc.my - pc.v.y) / pc.v.z) * z });
      return;
    }
    const p = pan.current;
    if (p) {
      const dx = e.clientX - p.px, dy = e.clientY - p.py;
      if (!p.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      p.moved = true;
      setView((v) => ({ ...v, x: p.vx + dx, y: p.vy + dy }));
      return;
    }
    const d = drag.current; if (!d || !canvas) return;
    const dx = (e.clientX - d.px) / zoom, dy = (e.clientY - d.py) / zoom;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    d.moved = true;
    setCanvas({ ...canvas, items: canvas.items.map((o) => {
      const s = d.start[o.id]; if (!s) return o;
      return d.resize ? { ...o, w: Math.max(60, Math.round(s.x + dx)), ...(o.kind !== "note" ? { h: Math.max(30, Math.round(s.y + dy)) } : {}) }
        : { ...o, x: Math.round(s.x + dx), y: Math.round(s.y + dy) };
    }) });
  };
  const onUp = (e: React.PointerEvent) => {
    pts.current.delete(e.pointerId);
    if (pts.current.size < 2) pinch.current = null;
    const p = pan.current;
    if (p) { pan.current = null; if (!p.moved) setSel(null); return; }
    const d = drag.current; drag.current = null;
    if (d?.moved && live.current) {
      const layer = vp.current;
      const heightOf = (it: Item) => {
        const el = layer?.querySelector<HTMLElement>(`[data-id="${CSS.escape(it.id)}"]`);
        return el ? el.offsetHeight : (it.h ?? 40);
      };
      // sections holding the dragged card's top-left corner before and after the drag get fitted to their contents
      const fit: string[] = [];
      if (!d.resize && d.ids.length === 1 && byId[d.ids[0]]?.kind !== "section") {
        const now = live.current.items.find((o) => o.id === d.ids[0]);
        const pts = [d.start[d.ids[0]], now && { x: now.x!, y: now.y! }].filter(Boolean) as { x: number; y: number }[];
        for (const sct of live.current.items) if (sct.kind === "section" &&
          pts.some((p) => p.x >= sct.x! && p.y >= sct.y! && p.x < sct.x! + sct.w! && p.y < sct.y! + sct.h!)) fit.push(sct.id);
      }
      save(settle(live.current.items, d.ids, heightOf, fit));
    }
  };

  // ---- editing
  const startEdit = (it: Item) => { setEditing(it.id); setDraft(it.text ?? ""); setSel(it.id); };
  const commitEdit = () => {
    if (!editing) return;
    const id = editing; setEditing(null);
    if (byId[id] && byId[id].text !== draft) save(items.map((o) => (o.id === id ? { ...o, text: draft } : o)));
  };

  // ---- adding / changing / removing
  const add = (kind: Item["kind"], color: Color, text: string) => {
    const x = Math.round((60 - view.x) / zoom), y = Math.round((60 - view.y) / zoom);
    const it: Item = kind === "note" ? { id: newId(items), kind, x, y, w: 260, text }
      : { id: newId(items), kind, x, y, w: kind === "section" ? 360 : 180, h: kind === "section" ? 300 : 84, text, color };
    save([...items, it]); setSel(it.id); startEdit(it);
  };
  // ---- pictures: drop files on the board or paste (⌘V) a screenshot; stored in <P>/story/images/
  const addImages = async (files: File[], at?: { cx: number; cy: number }) => {
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    const c = live.current;
    if (!imgs.length || !c) return;
    const r = vp.current?.getBoundingClientRect();
    const v = viewRef.current;
    let px = at && r ? at.cx - r.left : (r ? r.width / 2 - 150 : 60), py = at && r ? at.cy - r.top : (r ? r.height / 2 - 100 : 60);
    const added: Item[] = [];
    for (const f of imgs.slice(0, 8)) {
      try {
        const url = await imageToDataUrl(f);
        const blob = await (await fetch(url)).blob();
        const dim = await new Promise<{ w: number; h: number }>((res) => {
          const im = new Image();
          im.onload = () => res({ w: im.naturalWidth || 400, h: im.naturalHeight || 300 });
          im.onerror = () => res({ w: 400, h: 300 });
          im.src = url;
        });
        const up = await fetch(`/api/story/${c.project}/image`, { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
        const j = await up.json().catch(() => null);
        if (!up.ok) { toast(`Image not added: ${typeof j?.detail === "string" ? j.detail : `HTTP ${up.status}`}`); continue; }
        const w = Math.max(60, Math.min(420, dim.w));
        added.push({ id: newId([...committed.current, ...added]), kind: "image", src: j.src, text: "",
          x: Math.round((px - v.x) / v.z), y: Math.round((py - v.y) / v.z), w, h: Math.max(30, Math.round((w * dim.h) / dim.w)) });
        px += 24; py += 24;
      } catch (e) { toast(`Image not added: ${String(e)}`); }
    }
    if (added.length && live.current?.project === c.project) {
      save([...committed.current, ...added]); setSel(added[added.length - 1].id);
      toast(`Added ${added.length} image${added.length > 1 ? "s" : ""}`);
    }
  };
  const addImagesRef = useRef(addImages);
  addImagesRef.current = addImages;
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, [contenteditable], .chat")) return; // the agent box handles its own paste
      const files = Array.from(e.clipboardData?.items ?? [])
        .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
        .map((it) => it.getAsFile()).filter((f): f is File => f !== null);
      if (files.length) { e.preventDefault(); void addImagesRef.current(files); }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);
  const [dropping, setDropping] = useState(false);

  const recolor = (c: Color) => sel && save(items.map((o) => (o.id === sel ? { ...o, color: c } : o)));
  const remove = () => {
    if (!sel) return;
    const gone = byId[sel];
    const next = items.filter((o) => o.id !== sel && o.from !== sel && o.to !== sel);
    save(next); setSel(null);
    toast(`Deleted ${gone?.kind ?? "item"}`, () => save([...next, ...items.filter((o) => o.id === sel || o.from === sel || o.to === sel)]));
  };
  const undo = () => {
    const prev = undoStack.current.pop(); if (!prev) return;
    redoStack.current.push(committed.current); setSel(null); save(prev, false);
  };
  const redo = () => {
    const next = redoStack.current.pop(); if (!next) return;
    undoStack.current.push(committed.current); setSel(null); save(next, false);
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (editing) return;
      const tgt = e.target as HTMLElement;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !tgt.closest("input, textarea, select, [contenteditable]")) {
        e.preventDefault(); if (e.shiftKey) redo(); else undo(); return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y" && !tgt.closest("input, textarea, select, [contenteditable]")) {
        e.preventDefault(); redo(); return;
      }
      if (e.key === "Escape" && full) { setFull(false); return; }
      if (!sel) return;
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, [contenteditable]")) return;
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); remove(); }
      if (e.key === "Enter") { e.preventDefault(); const it = byId[sel]; if (it && it.kind !== "arrow") startEdit(it); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  const selected = sel ? byId[sel] : null;
  const zoomBy = (f: number) => { const el = vp.current; if (el) zoomAt(el.clientWidth / 2, el.clientHeight / 2, zoom * f); };

  // ---- arrows: straight line between the facing edges of two boxes
  const arrowPath = (a: Item, b: Item) => {
    const ah = a.h ?? 40, bh = b.h ?? 40;
    const acx = a.x! + a.w! / 2, acy = a.y! + ah / 2, bcx = b.x! + b.w! / 2, bcy = b.y! + bh / 2;
    const horiz = Math.abs(bcx - acx) * ah > Math.abs(bcy - acy) * a.w!;
    const [x1, y1] = horiz ? [bcx > acx ? a.x! + a.w! : a.x!, acy] : [acx, bcy > acy ? a.y! + ah : a.y!];
    const [x2, y2] = horiz ? [bcx > acx ? b.x! : b.x! + b.w!, bcy] : [bcx, bcy > acy ? b.y! : b.y! + bh];
    return { x1, y1, x2, y2 };
  };

  return (
    <div ref={root} className={`story${full ? " full" : ""}${full && withAgent ? " with-agent" : ""}`}>
      <div className="toolbar story-bar">
        <span className="seg" role="tablist" aria-label="Project">
          {(projects ?? []).map((p) => (
            <button key={p} role="tab" aria-selected={project === p} className={project === p ? "on" : ""} onClick={() => setProject(p)}>{p}</button>
          ))}
        </span>
        <button onClick={() => add("card", "support", NEW_EVIDENCE)}>+ Evidence</button>
        <button onClick={() => add("card", "gap", "⚠ Gap: ")}>+ Gap</button>
        <button onClick={() => add("card", "reviewer", "❓ Reviewer: ")}>+ Reviewer Q</button>
        <button onClick={() => add("note", "plain", "Claim: ")}>+ Note</button>
        <button aria-label="Undo" title="Undo (⌘Z)" disabled={!undoStack.current.length} onClick={undo}>↶</button>
        <button aria-label="Redo" title="Redo (⌘⇧Z)" disabled={!redoStack.current.length} onClick={redo}>↷</button>
        <span className="sep" />
        <button className="quick" title={`${REVIEW_CMD} ${project}: the agent re-tags relevance, updates gaps and reviewer questions`}
          onClick={() => onPrompt(`${REVIEW_CMD} ${project}`)}>{REVIEW_CMD}</button>
        <span className="sep" />
        <button aria-label="Zoom out" onClick={() => zoomBy(1 / 1.2)}>−</button>
        <span className="muted zoom">{Math.round(zoom * 100)}%</span>
        <button aria-label="Zoom in" onClick={() => zoomBy(1.2)}>+</button>
        <button title="Show the whole canvas" onClick={() => fitTo("all")}>Fit</button>
        <button title="Fit the width" onClick={() => fitTo("width")}>Fit width</button>
        <button onClick={load}>Refresh</button>
        <button aria-pressed={full} title={full ? "Exit full screen (Esc)" : "Full screen"} onClick={toggleFull}>{full ? "Exit full screen" : "Full screen"}</button>
        {full && <button aria-pressed={withAgent} onClick={() => setWithAgent((w) => !w)}>{withAgent ? "Hide agent" : "Show agent"}</button>}
        <span className="muted small">{saving ? "Saving…" : canvas ? `v${canvas.version} · ${canvas.file}` : ""}</span>
      </div>

      {selected && selected.kind !== "arrow" && !editing && (
        <div className="story-sel">
          <span className="muted small">Selected:</span>
          {selected.kind !== "note" && selected.kind !== "image" && (
            <select aria-label="Card type" value={selected.color ?? "plain"} onChange={(e) => recolor(e.target.value as Color)}>
              {COLOR_LABEL.map(([c, l]) => <option key={c} value={c}>{l}</option>)}
            </select>
          )}
          <button onClick={() => startEdit(selected)}>Edit</button>
          <button className="ask small" onClick={() => onAsk(`Story card: ${(selected.text ?? "").split("\n")[0].slice(0, 50)}`,
            `${project} story canvas (${canvas?.file})\n${cardText(selected, sections)}`)}>Ask agent</button>
          <button onClick={remove}>Delete</button>
          <span className="muted small">Double-click to edit · drag to move · corner to resize</span>
        </div>
      )}

      {error && <p className="error" role="alert">{error}</p>}
      {projectsError && <p className="error" role="alert">projects.yaml: {projectsError}</p>}
      {projects && projects.length === 0 && !projectsError && (
        <p className="muted">No projects yet. Add them to <code>projects.yaml</code> in your Research folder, or ask the agent
          “set up my workspace”.</p>
      )}
      {canvas && items.length === 0 && (
        <p className="muted">This canvas is empty. Ask the agent “set up the {project} story canvas from the paper”, or add evidence with the buttons above.</p>
      )}

      <div className={`story-vp${dropping ? " dropping" : ""}`} ref={vp}
        onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setDropping(true); } }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDropping(false); }}
        onDrop={(e) => {
          setDropping(false);
          const files = Array.from(e.dataTransfer.files);
          if (files.some((f) => f.type.startsWith("image/"))) { e.preventDefault(); void addImages(files, { cx: e.clientX, cy: e.clientY }); }
        }}

        style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${24 * zoom}px ${24 * zoom}px` }}
        onPointerDownCapture={onDownCapture} onPointerDown={onBgDown}
        onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <div className="story-layer" style={{ width: bounds.w, height: bounds.h, transform: `translate(${view.x}px, ${view.y}px) scale(${zoom})` }}>
            {sections.map((s) => (
              <div key={s.id} data-id={s.id} className={`sc-section c-${s.color ?? "plain"} ${sel === s.id ? "sel" : ""}`}
                style={{ left: s.x, top: s.y, width: s.w, height: s.h }}>
                <div className="sc-section-title" onPointerDown={(e) => onDown(e, s)} onDoubleClick={() => startEdit(s)}>
                  {editing === s.id ? null : <span dangerouslySetInnerHTML={{ __html: richText(s.text ?? "") }} />}
                </div>
                {editing === s.id && <Editor value={draft} onChange={setDraft} onDone={commitEdit} onCancel={() => setEditing(null)} />}
                <span className="sc-resize" onPointerDown={(e) => onDown(e, s, true)} />
              </div>
            ))}
            <svg className="sc-arrows" width={bounds.w} height={bounds.h} aria-hidden="true">
              <defs><marker id="sc-head" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" /></marker></defs>
              {items.filter((a) => a.kind === "arrow" && byId[a.from!] && byId[a.to!]).map((a) => {
                const p = arrowPath(byId[a.from!], byId[a.to!]);
                return <line key={a.id} {...p} markerEnd="url(#sc-head)" />;
              })}
            </svg>
            {items.filter((i) => i.kind === "image").map((it) => (
              <div key={it.id} data-id={it.id} className={`sc-image ${sel === it.id ? "sel" : ""}`}
                style={{ left: it.x, top: it.y, width: it.w }}
                onPointerDown={(e) => onDown(e, it)} onDoubleClick={() => startEdit(it)}>
                <img src={`/api/story/${project}/image/${it.src}`} alt={it.text || "image"} draggable={false} style={{ height: it.h }} />
                {editing === it.id
                  ? <Editor value={draft} onChange={setDraft} onDone={commitEdit} onCancel={() => setEditing(null)} />
                  : it.text ? <div className="sc-caption" dangerouslySetInnerHTML={{ __html: richText(it.text) }} /> : null}
                <span className="sc-resize" onPointerDown={(e) => onDown(e, it, true)} />
              </div>
            ))}
            {items.filter((i) => i.kind === "card" || i.kind === "note").map((it) => (
              <div key={it.id} data-id={it.id} className={`sc-${it.kind} c-${it.color ?? "plain"} s-${it.size ?? "body"} ${sel === it.id ? "sel" : ""}`}
                style={{ left: it.x, top: it.y, width: it.w, minHeight: it.kind === "card" ? it.h : undefined }}
                onPointerDown={(e) => onDown(e, it)} onDoubleClick={() => startEdit(it)}>
                {editing === it.id
                  ? <Editor value={draft} onChange={setDraft} onDone={commitEdit} onCancel={() => setEditing(null)} />
                  : <span dangerouslySetInnerHTML={{ __html: richText(it.text ?? "") }} />}
                <span className="sc-resize" onPointerDown={(e) => onDown(e, it, true)} />
              </div>
            ))}
          </div>
      </div>
    </div>
  );
}

function Editor({ value, onChange, onDone, onCancel }: { value: string; onChange: (v: string) => void; onDone: () => void; onCancel: () => void }) {
  // Grow with the text so the editor is as big as the card it replaces (no inner scrollbar).
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);
  return (
    <textarea ref={ref} className="sc-editor" autoFocus value={value} aria-label="Edit text"
      onPointerDown={(e) => e.stopPropagation()}
      onFocus={(e) => { const n = e.currentTarget.value.length; e.currentTarget.setSelectionRange(n, n); }}
      onChange={(e) => onChange(e.target.value)} onBlur={onDone}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onDone();
      }} />
  );
}
