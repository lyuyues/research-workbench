import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { Markdown } from "./common";

/** Split markdown into reply-able blocks: each top-level list item (with its continuation lines) or paragraph. */
export function splitBlocks(md: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  const flush = () => { const t = cur.join("\n").trim(); if (t) out.push(t); cur = []; };
  for (const line of md.split("\n")) {
    if (/^([-*+]|\d+[.)])\s/.test(line)) { flush(); cur.push(line); }       // a new top-level item
    else if (!line.trim()) { if (cur.length && !/^([-*+]|\d+[.)])\s/.test(cur[0])) flush(); }  // blank ends a paragraph
    else cur.push(line);                                                     // continuation / nested line
  }
  flush();
  return out;
}

type ReplyFn = (label: string, context: string, reply: string) => void;

/** The reply box that opens under an item. */
function ReplyBox({ label, context, onReply, onSaveNote, onClose }: {
  label: string; context: string; onReply?: ReplyFn; onSaveNote?: (reply: string) => Promise<string | null>;
  onClose: (done: string | null) => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const send = () => { if (onReply && draft.trim()) { onReply(label, context, draft.trim()); onClose("sent to agent"); } };
  return (
    <div className="reply item-reply" onDoubleClick={(e) => e.stopPropagation()}>
      <textarea autoFocus rows={2} value={draft} aria-label="Reply to this item" placeholder="Reply to this item…  (⌘↩ send · Esc close)"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
          if (e.key === "Escape") onClose(null);
        }} />
      <div className="toolbar">
        {onReply && <button disabled={!draft.trim()} onClick={send}>Send to agent</button>}
        {onSaveNote && <button disabled={!draft.trim() || busy} title="Saved into today's message to Claude; Claude handles it at the next daily check"
          onClick={async () => {
            setBusy(true);
            const e = await onSaveNote(draft.trim());
            setBusy(false);
            if (e) setErr(e); else onClose("saved as note");
          }}>Save as note</button>}
        <button className="linkish" onClick={() => onClose(null)}>Cancel</button>
      </div>
      {err && <p className="error small">{err}</p>}
    </div>
  );
}

const INTERACTIVE = "a, button, input, textarea, select, label input, .item-reply";

/**
 * Wraps an item: double-click it (or long-press on a touch screen) to open a reply box right underneath.
 * Send = to the agent with `context` attached; Save as note is optional. No visible button, so no extra line;
 * a replied item gets a thin accent mark on its left.
 */
export function Replyable({ label, context, onReply, onSaveNote, children, className = "" }: {
  label: string; context: string; onReply?: ReplyFn; onSaveNote?: (reply: string) => Promise<string | null>;
  children: ReactNode; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const press = useRef<{ t: number; x: number; y: number } | null>(null);
  if (!onReply && !onSaveNote) return <div className={className}>{children}</div>;
  const openBox = (target: EventTarget | null) => {
    if ((target as HTMLElement | null)?.closest?.(INTERACTIVE)) return;
    window.getSelection?.()?.removeAllRanges();
    setOpen(true);
  };
  const cancelPress = () => { if (press.current) { clearTimeout(press.current.t); press.current = null; } };
  return (
    <div className={`replyable${done ? " replied" : ""}${open ? " open" : ""} ${className}`}
      title={done ? `Replied (${done}) · double-click to reply again` : "Double-click to reply"}
      onDoubleClick={(e) => openBox(e.target)}
      onPointerDown={(e) => {
        if (e.pointerType !== "touch") return;
        const target = e.target;
        press.current = { x: e.clientX, y: e.clientY, t: window.setTimeout(() => { press.current = null; openBox(target); }, 550) };
      }}
      onPointerMove={(e) => { const p = press.current; if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8) cancelPress(); }}
      onPointerUp={cancelPress} onPointerCancel={cancelPress}>
      {children}
      {open && <ReplyBox label={label} context={context} onReply={onReply} onSaveNote={onSaveNote}
        onClose={(d) => { setOpen(false); if (d) setDone(d); }} />}
    </div>
  );
}

/** A note rendered item by item; double-click an item to reply to it. */
export function ReplyableNote({ text, base, label, onReply, onSaveNote }: {
  text: string; base: string; label: string; onReply?: ReplyFn;
  onSaveNote?: (block: string, reply: string) => Promise<string | null>;
}) {
  if (!onReply && !onSaveNote) return <Markdown text={text} base={base} />;
  return (
    <div className="note-blocks">
      {splitBlocks(text).map((b, k) => (
        <Replyable key={k} className="note-block" label={label} context={`${label}\n\n${b}`} onReply={onReply}
          onSaveNote={onSaveNote ? (r) => onSaveNote(b, r) : undefined}>
          <Markdown text={b} base={base} />
        </Replyable>
      ))}
    </div>
  );
}

const loadOrder = (key: string): string[] => {
  try { const v = JSON.parse(localStorage.getItem(key) ?? "[]"); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
};

/** The user's saved order (ids that still exist); ids it doesn't know go right after their default predecessor. */
export function mergeOrder(saved: string[], ids: string[]): string[] {
  const out = saved.filter((id) => ids.includes(id));
  ids.forEach((id, k) => {
    if (out.includes(id)) return;
    const prev = ids.slice(0, k).reverse().find((p) => out.includes(p));
    out.splice(prev === undefined ? 0 : out.indexOf(prev) + 1, 0, id);
  });
  return out;
}

/**
 * Cards the user can rearrange: drag the grip bar at the top of a card (mouse or touch), or focus it and
 * use the arrow keys. The order is remembered per browser (localStorage `storageKey`).
 */
export function SortableCards({ storageKey, items, className = "cards" }: {
  storageKey: string; items: { id: string; wide?: boolean; label: string; node: ReactNode }[]; className?: string;
}) {
  const ids = items.map((i) => i.id);
  // `saved` holds only what the user arranged (cards that load later keep their default place).
  const [saved, setSaved] = useState<string[]>(() => loadOrder(storageKey));
  const order = mergeOrder(saved, ids);
  const [dragging, setDragging] = useState<string | null>(null);
  const live = useRef(order);
  live.current = order;
  const setOrder = (f: (o: string[]) => string[]) => setSaved(() => f(live.current));
  const save = (o: string[]) => { try { localStorage.setItem(storageKey, JSON.stringify(o)); } catch { /* private mode */ } };
  const moveTo = (id: string, target: string) => setOrder((o) => {
    if (id === target) return o;
    const rest = o.filter((x) => x !== id);
    const at = rest.indexOf(target);
    const after = o.indexOf(id) < o.indexOf(target);
    rest.splice(after ? at + 1 : at, 0, id);
    return rest;
  });
  const step = (id: string, d: number) => setOrder((o) => {
    const i = o.indexOf(id), j = i + d;
    if (j < 0 || j >= o.length) return o;
    const n = [...o]; [n[i], n[j]] = [n[j], n[i]]; save(n); return n;
  });
  const byId = new Map(items.map((i) => [i.id, i]));
  return (
    <div className={`${className} sortable${dragging ? " is-dragging" : ""}`}>
      {order.map((id) => {
        const it = byId.get(id);
        if (!it) return null;
        return (
          <div key={id} data-sort-id={id} className={`sort-item${it.wide ? " wide" : ""}${dragging === id ? " dragging" : ""}`}>
            <button className="grip" aria-label={`Move ${it.label} (drag, or arrow keys)`} title="Drag to move this card"
              onPointerDown={(e) => { e.preventDefault(); (e.target as HTMLElement).setPointerCapture?.(e.pointerId); setDragging(id); }}
              onPointerMove={(e) => {
                if (dragging !== id) return;
                const el = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-sort-id]") as HTMLElement | null;
                const target = el?.dataset.sortId;
                if (target && target !== id) moveTo(id, target);
              }}
              onPointerUp={() => { if (dragging) { save(live.current); setDragging(null); } }}
              onPointerCancel={() => { if (dragging) { save(live.current); setDragging(null); } }}
              onKeyDown={(e) => {
                if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); step(id, -1); }
                if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); step(id, 1); }
              }} />
            {it.node}
          </div>
        );
      })}
    </div>
  );
}

export function resetCardOrder(storageKey: string) {
  try { localStorage.removeItem(storageKey); } catch { /* ignore */ }
}

type ProjectLinks = Record<string, Record<string, string>>;
const LINK_LABEL: Record<string, string> = { notion: "Notion", overleaf: "Overleaf", github: "GitHub", drive: "Drive" };

/** Links for a project name from project_links.json (exact name, else case-insensitive / contained match). */
export function linksFor(all: ProjectLinks | null | undefined, name: string): Record<string, string> {
  if (!all) return {};
  const n = name.replace(/[*_`]/g, "").trim().toLowerCase();
  const key = Object.keys(all).find((k) => k.toLowerCase() === n)
    ?? Object.keys(all).find((k) => n.includes(k.toLowerCase()) || k.toLowerCase().includes(n));
  return key ? all[key] : {};
}

/** Small "Notion ↗" (etc.) links shown next to a project's name. */
export function ProjectLinksInline({ all, name }: { all: ProjectLinks | null | undefined; name: string }) {
  const l = linksFor(all, name);
  const keys = Object.keys(l);
  if (!keys.length) return null;
  return (
    <span className="proj-links">
      {keys.map((k) => <a key={k} href={l[k]} target="_blank" rel="noreferrer" title={`${name} on ${LINK_LABEL[k] ?? k}`}>{LINK_LABEL[k] ?? k} ↗</a>)}
    </span>
  );
}
