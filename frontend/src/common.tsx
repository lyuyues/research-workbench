import { useCallback, useEffect, useState, useRef } from "react";
import type { ReactNode } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

/** "Ask agent" (attach a card) and quick actions (prefill a prompt) shared by every panel. */
export interface PanelProps {
  onAsk: (label: string, text: string) => void;
  onPrompt: (text: string) => void;
  /** reply to one item of a card: the context is attached and the reply sent to the agent right away */
  onReply?: (label: string, context: string, reply: string) => void;
  /** send this to the agent right away (quick-action buttons that need no editing) */
  onRun?: (text: string) => void;
}

export type Load<T> = { data: T | null; error: string | null; reload: () => void };

export function useJson<T>(url: string | null): Load<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const reload = useCallback(() => setN((x) => x + 1), []);
  useEffect(() => {
    if (!url) return;
    let live = true;
    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as T;
        if (live) { setData(j); setError(null); }
      })
      .catch((e: unknown) => { if (live) setError(`Could not load (${e instanceof Error ? e.message : String(e)})`); });
    return () => { live = false; };
  }, [url, n]);
  return { data, error, reload };
}

export async function postJson(url: string, body: unknown): Promise<string | null> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.ok) return null;
    const j = await r.json().catch(() => null) as { detail?: unknown } | null;
    return typeof j?.detail === "string" ? j.detail : `HTTP ${r.status}`;
  } catch (e) {
    return `network error: ${String(e)}`;
  }
}

export interface Check { line: number; text: string; checked: boolean; raw: string; indent?: number; id?: string | null }

/** A markdown checkbox that writes back to its file (verified by the line's current text). */
// ---- toasts with Undo (e.g. a checkbox ticked by accident) --------------------------------------------
interface ToastItem { id: number; msg: string; undo?: () => void }
let pushToast: (t: Omit<ToastItem, "id">) => void = () => {};
export const toast = (msg: string, undo?: () => void) => pushToast({ msg, undo });

export function Toasts() {
  const [list, setList] = useState<ToastItem[]>([]);
  useEffect(() => {
    pushToast = (t) => {
      const id = Date.now() + Math.random();
      setList((l) => [...l.slice(-2), { ...t, id }]);
      window.setTimeout(() => setList((l) => l.filter((x) => x.id !== id)), 8000);
    };
    return () => { pushToast = () => {}; };
  }, []);
  if (!list.length) return null;
  return (
    <div className="toasts" role="status">
      {list.map((t) => (
        <div key={t.id} className="toast">
          <span>{t.msg}</span>
          {t.undo && <button onClick={() => { t.undo!(); setList((l) => l.filter((x) => x.id !== t.id)); }}>Undo</button>}
        </div>
      ))}
    </div>
  );
}

export function CheckItem({ path, item, onDone, onError, children, deferTextClick = false }: {
  path: string; item: Check; onDone: () => void; onError: (m: string) => void; children?: React.ReactNode;
  /** clicking the text ticks after a short wait, so a double-click (= reply) doesn't tick and untick */
  deferTextClick?: boolean;
}) {
  const clickTimer = useRef<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState(item.checked);
  useEffect(() => setChecked(item.checked), [item.checked, item.raw]);
  const toggle = async () => {
    setBusy(true);
    const next = !checked;
    setChecked(next);
    const send = async (line: number, expect: string, on: boolean) => {
      const r = await fetch("/api/edit/checkbox", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, line, expect, checked: on }) });
      const j = await r.json().catch(() => null) as { line?: number; raw?: string; detail?: unknown } | null;
      return r.ok ? { raw: j?.raw ?? expect, line: j?.line ?? line } : { error: typeof j?.detail === "string" ? j.detail : `HTTP ${r.status}` };
    };
    const res = await send(item.line, item.raw, next);
    setBusy(false);
    if ("error" in res) { setChecked(!next); onError(res.error!); onDone(); return; }
    const label = item.text.replace(/[*`_]/g, "").slice(0, 60);
    toast(`${next ? "✓ Ticked" : "↺ Unticked"}: ${label}`, async () => {
      const back = await send(res.line, res.raw, !next);
      if ("error" in back) onError(back.error!);
      onDone();
    });
    onDone();
  };
  return (
    <label className={`check ${checked ? "done" : ""}`} style={item.indent ? { marginLeft: item.indent * 6 } : undefined}
      onClick={deferTextClick ? (e) => {
        if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).closest("a")) return;
        e.preventDefault(); // don't let the label tick the box right away
        if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null; }
        if (e.detail === 1 && !busy) clickTimer.current = window.setTimeout(() => { clickTimer.current = null; void toggle(); }, 260);
      } : undefined}>
      <input type="checkbox" checked={checked} disabled={busy} onChange={toggle} />
      <span>{children ?? <Inline text={item.text} />}</span>
    </label>
  );
}

marked.setOptions({ gfm: true, breaks: false });

export function mdHtml(text: string): string {
  // YAML front matter (e.g. Marp's "marp: true") is settings, not content
  const body = text.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");
  return DOMPurify.sanitize(marked.parse(body, { async: false }) as string);
}

/** Inline markdown (bold, links, code) for one line. */
export function Inline({ text, base = "" }: { text: string; base?: string }) {
  const html = DOMPurify.sanitize(marked.parseInline(text, { async: false }) as string);
  return <span className="md-inline" data-base={base} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** `base` = path of the file the text came from; relative links resolve against it (see App). */
export function Markdown({ text, base = "" }: { text: string; base?: string }) {
  return <div className="md" data-base={base} dangerouslySetInnerHTML={{ __html: mdHtml(text) }} />;
}

/** Research-relative path for a link inside a file at `base`, or null for external links. */
export function resolveLink(href: string, base: string): { path: string; anchor: string | null } | null {
  if (!href || /^[a-z]+:/i.test(href) || href.startsWith("//")) return null;
  const [raw, anchor = null] = href.split("#", 2) as [string, string?];
  if (!raw) return null;
  const parts = (raw.startsWith("/") ? [] : base.split("/").slice(0, -1));
  for (const seg of decodeURIComponent(raw).split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { if (!parts.length) return null; parts.pop(); } else parts.push(seg);
  }
  return parts.length ? { path: parts.join("/"), anchor } : null;
}

/** Loads a text file from the Research folder and renders it (markdown) or shows it raw. */
const ANNOT = /^>\s*⚠️\s*\*\*Question for you\*\*/;

/** A ⚠️ Question for you block inside a markdown file: double-click it to write the answer right below it. */
function AnnotBlock({ path, line, endLine, endRaw, text, onSaved }: { path: string; line: number; endLine: number; endRaw: string;
  text: string; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const answered = text.includes("→ the user:");
  const save = async () => {
    setBusy(true);
    const e = await postJson("/api/edit/annotation-reply", { path, line, end_line: endLine, end_raw: endRaw, text: draft });
    setBusy(false);
    if (e) { setErr(e); return; }
    setOpen(false); setDraft(""); setErr(null); onSaved();
  };
  return (
    <div className={`annot-block${answered ? " answered" : ""}${open ? " open" : ""}`}
      title={open ? undefined : answered ? "Answered · double-click to add more" : "Double-click to answer"}
      onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest("textarea, button, a")) { window.getSelection?.()?.removeAllRanges(); setOpen(true); } }}>
      <Markdown text={text} base={path} />
      {!open && !answered && <div className="muted small annot-hint">Double-click to answer</div>}
      {open && (
        <div className="reply">
          <textarea autoFocus rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Your answer"
            placeholder="Your answer (saved under this question as “→ the user: …”)  ⌘↩ save · Esc close"
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && draft.trim()) void save(); if (e.key === "Escape") setOpen(false); }} />
          <div className="toolbar">
            <button onClick={() => void save()} disabled={busy || !draft.trim()}>Save answer</button>
            <button className="linkish" onClick={() => setOpen(false)}>Cancel</button>
          </div>
          {err && <p className="error small">{err}</p>}
        </div>
      )}
    </div>
  );
}

/** Markdown with its ⚠️ question blocks made answerable in place. */
function AnnotatedMarkdown({ text, path, onSaved }: { text: string; path: string; onSaved: () => void }) {
  const lines = text.split("\n");
  const parts: ReactNode[] = [];
  let buf: string[] = [];
  const flush = (k: number) => { if (buf.length) parts.push(<Markdown key={`m${k}`} text={buf.join("\n")} base={path} />); buf = []; };
  for (let i = 0; i < lines.length; i++) {
    if (!ANNOT.test(lines[i])) { buf.push(lines[i]); continue; }
    flush(i);
    let j = i + 1;
    while (j < lines.length && lines[j].startsWith(">")) j++;
    parts.push(<AnnotBlock key={`q${i}`} path={path} line={i + 1} endLine={j} endRaw={lines[j - 1]}
      text={lines.slice(i, j).join("\n")} onSaved={onSaved} />);
    i = j - 1;
  }
  flush(lines.length);
  return <div className="md-annotated">{parts}</div>;
}

/** TeX source with comments greyed out (Claude's %% notes stay in the platform draft, not on Overleaf). */
function texLines(text: string) {
  return text.split("\n").map((ln, i) => {
    const m = /(^|[^\\])(%.*)$/.exec(ln);
    if (!m) return <span key={i}>{ln}{"\n"}</span>;
    const at = m.index + m[1].length;
    return <span key={i}>{ln.slice(0, at)}<span className="tex-comment">{ln.slice(at)}</span>{"\n"}</span>;
  });
}

/** `onSave` makes a markdown file editable here (split editor + live preview); it returns an error message or null. */
export function FileView({ path, anchor, onClose, onSave }: { path: string; anchor?: string | null; onClose?: () => void;
  onSave?: (text: string, base: string) => Promise<string | null> }) {
  const { data, error, reload } = useJson<{ text: string; mtime: number; editable?: boolean; sha?: string; paper?: string }>(
    `/api/file?path=${encodeURIComponent(path)}`);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  // ⌘S / Ctrl+S saves the draft anywhere on the page while editing (never the browser's "Save page")
  const saveRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (draft === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "s" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveRef.current(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft === null]); // eslint-disable-line react-hooks/exhaustive-deps
  const savedSha = useRef<string | null>(null);
  const savedText = useRef<string | null>(null);   // sha after our own last save, so ⌘S can be pressed again and again
  const mdEdit = !!onSave && path.endsWith(".md");
  const saveOverleaf = async () => {
    if (draft === null) return;
    if (mdEdit) {
      setSaving(true); setSaveMsg(null);
      const err = await onSave!(draft, savedSha.current ?? data?.text ?? "");
      setSaving(false);
      if (err) { setSaveMsg(`⚠️ ${err}`); return; }
      savedText.current = draft;
      savedSha.current = draft.trimEnd() + "\n";   // what the server wrote: the base for the next ⌘S
      setSaveMsg(`✓ Saved ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
      return;
    }
    if (!data?.sha) return;
    setSaving(true); setSaveMsg(null);
    const r = await fetch("/api/paper/save", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, sha: savedSha.current ?? data.sha, text: draft }) });
    const j = await r.json().catch(() => null) as { detail?: string; sha?: string } | null;
    setSaving(false);
    if (!r.ok) { setSaveMsg(`⚠️ ${j?.detail ?? `HTTP ${r.status}`}`); return; }
    savedSha.current = j?.sha ?? null;
    savedText.current = draft;
    setSaveMsg(`✓ Saved ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · PDF updating`);
  };
  const stopEditing = async () => {
    if (draft !== null && draft !== (savedText.current ?? data?.text)) {
      await saveOverleaf();
      if (savedText.current !== draft) return;  // save failed: stay in the editor, message is shown
    }
    savedSha.current = null; savedText.current = null; setDraft(null); reload();
  };
  saveRef.current = () => { if (!saving) void saveOverleaf(); };
  useEffect(() => {
    if (!data || !anchor) return;
    const el = document.getElementById(anchor) ??
      [...document.querySelectorAll(".fileview h1, .fileview h2, .fileview h3")].find((h) =>
        slug(h.textContent ?? "") === anchor);
    el?.scrollIntoView({ block: "start" });
  }, [data, anchor]);
  // Real browser full screen of this card (Esc / "Exit full screen" returns to the same view, edits kept)
  const [full, setFull] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sync = () => setFull(document.fullscreenElement === cardRef.current && !!cardRef.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);
  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (cardRef.current?.requestFullscreen) void cardRef.current.requestFullscreen().catch(() => setFull((f) => !f));
    else setFull((f) => !f);
  };
  return (
    <div ref={cardRef} className={`card fileview${full ? " fileview-full" : ""}`}>
      <div className="card-head">
        <b className="small">{path}</b>
        {data && <span className="muted small">· {when(data.mtime)} · {mdEdit
          ? (draft === null ? "double-click or ✎ Edit to change it" : "editing · preview on the right")
          : data.editable
          ? (draft === null ? "platform draft · Overleaf gets the clean version via Writing › Publish" : "editing the platform draft")
          : path.endsWith(".md") && data.text.includes("Question for you") ? "double-click a ⚠️ question to answer it" : "read-only"}</span>}
        {(data?.editable || (data && mdEdit)) && draft === null && <button className="ask" onClick={() => { setSaveMsg(null); setDraft(data.text); }}>✎ Edit</button>}
        {data?.paper && <a className="linkish small" href={`#/pdf/${data.paper}`} target="_blank" rel="noreferrer">Live PDF ↗</a>}
        {draft !== null && <>
          <button onClick={() => void saveOverleaf()} disabled={saving}>{saving ? "Saving…" : "Save (⌘S)"}</button>
          <button className="linkish small" onClick={() => void stopEditing()}>Done</button>
        </>}
        {saveMsg && <span className="small">{saveMsg}</span>}
        <button className="linkish small fv-full" onClick={toggleFull} title="Esc to exit">{full ? "✕ Exit full screen" : "⤢ Full screen"}</button>
        {onClose && !full && <button className="ask" onClick={onClose}>Close</button>}
      </div>
      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && (mdEdit
        ? (draft !== null
          ? <div className="recap-split">
              <textarea className="recap-edit" value={draft} spellCheck aria-label="Edit file" onChange={(e) => setDraft(e.target.value)} />
              <div className="recap-preview"><Markdown text={draft} base={path} /></div>
            </div>
          : <div onDoubleClick={() => { setSaveMsg(null); setDraft(data.text); }} title="Double-click to edit"><Markdown text={data.text} base={path} /></div>)
        : path.endsWith(".md")
        ? (data.text.includes("Question for you") ? <AnnotatedMarkdown text={data.text} path={path} onSaved={reload} /> : <Markdown text={data.text} base={path} />)
        : draft !== null
          ? <textarea className="tex-editor" value={draft} spellCheck aria-label="Edit file"
              onChange={(e) => setDraft(e.target.value)} />
          : <pre className="transcript" onDoubleClick={data.editable ? () => { setSaveMsg(null); setDraft(data.text); } : undefined}
              title={data.editable ? "Double-click to edit" : undefined}>{/\.(tex|bib)$/.test(path) ? texLines(data.text) : data.text}</pre>)}
    </div>
  );
}

export const slug = (s: string) =>
  s.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-");

export const when = (ms: number | null | undefined) =>
  ms ? new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

export const ago = (ms: number | null | undefined) => {
  if (!ms) return "—";
  const d = (Date.now() - ms) / 86_400_000;
  return d < 1 ? "today" : d < 2 ? "yesterday" : `${Math.floor(d)} days ago`;
};

export const hm = (min: number) => {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m`;
};

/** Toolbar with Refresh and the panel's quick actions (CLAUDE.md shortcuts → agent input). */
export function Toolbar({ reload, actions, onPrompt, children }: {
  reload: () => void; actions?: [string, string][]; onPrompt: (t: string) => void; children?: React.ReactNode;
}) {
  return (
    <div className="toolbar">
      {children}
      {actions?.map(([label, prompt]) => (
        <button key={label} className="quick" title={prompt} onClick={() => onPrompt(prompt)}>{label}</button>
      ))}
      <button onClick={reload}>Refresh</button>
    </div>
  );
}

export function Notice({ msg, onClear }: { msg: string | null; onClear: () => void }) {
  if (!msg) return null;
  return <p className="error small" role="alert">{msg} <button className="linkish" onClick={onClear}>dismiss</button></p>;
}
