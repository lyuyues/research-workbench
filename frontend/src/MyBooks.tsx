import { useEffect, useMemo, useState } from "react";
import { postJson, useJson } from "./common";

export interface ZBook {
  key: string; title: string; authors: string[]; year: string; publisher?: string; type?: string;
  collections: string[]; tags: string[]; added?: string;
  attachment: { key: string; format: string; file: string; size: number } | null; file_on_mac: boolean;
  audiobook: string | null; status: "requested" | "converting" | "error" | null; error: string | null;
  progress?: { stage: "reading" | "ocr" | "tts"; done: number; total: number } | null;
}

export function progressText(p: ZBook["progress"]): string {
  if (!p) return "Waiting to convert…";
  if (p.stage === "ocr") return `OCR ${p.done}/${p.total} pages (${Math.round((100 * p.done) / Math.max(p.total, 1))}%)`;
  if (p.stage === "tts") return `Recording episode ${p.done + 1}/${p.total} (${p.done} ready)`;
  return "Reading the book…";
}
interface Shelf { books: ZBook[]; updated: number }

export interface Node { name: string; path: string; children: Node[]; count: number }
const UNFILED = "Unfiled";
const SHELF_ROOT = /^\d+\.\s*BOOKS$/i;
const norm = (s: string) => s.toLowerCase().normalize("NFKC");
const pathsOf = (b: ZBook) => (b.collections.length ? b.collections : [UNFILED]);
const inFolder = (p: string, folder: string) => !folder || p === folder || p.startsWith(folder + " / ");

export function matches(b: ZBook, q: string): boolean {
  const hay = norm([b.title, b.authors.join(" "), b.year, b.publisher ?? "", b.collections.join(" "), b.tags.join(" ")].join(" "));
  return norm(q).split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

/** Collection paths -> folder tree; count = distinct books in the folder and its subfolders. */
export function buildTree(books: ZBook[]): Node[] {
  const root: Node = { name: "", path: "", children: [], count: 0 };
  const sets = new Map<string, Set<string>>();
  for (const b of books) {
    for (const p of pathsOf(b)) {
      let node = root;
      const parts = p.split(" / ");
      parts.forEach((name, i) => {
        const path = parts.slice(0, i + 1).join(" / ");
        let child = node.children.find((c) => c.name === name);
        if (!child) { child = { name, path, children: [], count: 0 }; node.children.push(child); }
        if (!sets.has(path)) sets.set(path, new Set());
        sets.get(path)!.add(b.key);
        node = child;
      });
    }
  }
  const finish = (n: Node) => {
    n.count = sets.get(n.path)?.size ?? 0;
    n.children.forEach(finish);
    n.children.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  };
  root.children.forEach(finish);
  // the bookshelf first, then the rest by size
  return root.children.sort((a, b) => Number(SHELF_ROOT.test(b.name)) - Number(SHELF_ROOT.test(a.name)) || b.count - a.count);
}

function Tree({ nodes, sel, open, onSel, onToggle, depth = 0 }: {
  nodes: Node[]; sel: string; open: Set<string>; onSel: (p: string) => void; onToggle: (p: string) => void; depth?: number;
}) {
  return (
    <ul className="mb-tree" role={depth ? "group" : "tree"}>
      {nodes.map((n) => {
        const isOpen = open.has(n.path);
        return (
          <li key={n.path} role="treeitem" aria-expanded={n.children.length ? isOpen : undefined} aria-selected={sel === n.path}>
            <div className={`mb-node ${sel === n.path ? "sel" : ""}`} style={{ paddingLeft: 4 + depth * 14 }}>
              {n.children.length
                ? <button className="mb-twist" onClick={() => onToggle(n.path)} aria-label={`${isOpen ? "Collapse" : "Expand"} ${n.name}`}>{isOpen ? "▾" : "▸"}</button>
                : <span className="mb-twist" />}
              <button className="mb-folder" onClick={() => onSel(n.path)}>{n.name}</button>
              <span className="muted small">{n.count}</span>
            </div>
            {isOpen && n.children.length > 0 &&
              <Tree nodes={n.children} sel={sel} open={open} onSel={onSel} onToggle={onToggle} depth={depth + 1} />}
          </li>
        );
      })}
    </ul>
  );
}

export function MyBooks({ onListen }: { onListen: (slug: string) => void }) {
  const { data, error, reload } = useJson<Shelf>("/api/bookshelf");
  const active = !!data?.books.some((b) => b.status === "converting" || b.status === "requested");
  useEffect(() => {
    if (!active) return;
    const t = setInterval(reload, 20000);
    return () => clearInterval(t);
  }, [active, reload]);
  const [q, setQ] = useState("");
  const [folder, setFolder] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string> | null>(null);
  const [onlyFile, setOnlyFile] = useState(false);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const tree = useMemo(() => buildTree(data?.books ?? []), [data]);
  if (error) return <p className="error" role="alert">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const shelfRoot = tree.find((n) => SHELF_ROOT.test(n.name))?.path ?? "";
  const sel = folder ?? shelfRoot;
  const opened = open ?? new Set(shelfRoot ? [shelfRoot] : []);
  const toggle = (p: string) => setOpen(() => { const s = new Set(opened); if (s.has(p)) s.delete(p); else s.add(p); return s; });
  const pick = (p: string) => {
    setFolder(p);
    const s = new Set(opened);
    p.split(" / ").forEach((_, i, a) => s.add(a.slice(0, i + 1).join(" / ")));
    setOpen(s);
  };

  const shown = data.books.filter((b) => pathsOf(b).some((p) => inFolder(p, sel))
    && (!onlyFile || b.file_on_mac) && (!q.trim() || matches(b, q)));
  // group under the deepest folder each book sits in (first match only: no duplicates)
  const groups = new Map<string, ZBook[]>();
  for (const b of shown) {
    const p = pathsOf(b).filter((x) => inFolder(x, sel)).sort((a, b2) => b2.length - a.length)[0] ?? sel;
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p)!.push(b);
  }
  const groupList = [...groups.entries()].sort((a, b) => (a[0] === sel ? -1 : b[0] === sel ? 1 : a[0].localeCompare(b[0], "zh")));
  const rel = (p: string) => (p === sel ? (sel.split(" / ").pop() ?? "") : p.slice(sel ? sel.length + 3 : 0));

  const make = async (b: ZBook) => {
    setBusy((x) => ({ ...x, [b.key]: "…" }));
    const err = await postJson(`/api/bookshelf/${b.key}/audiobook`, {});
    setBusy((x) => ({ ...x, [b.key]: err ?? "" }));
    if (!err) reload();
  };

  return (
    <div className="mybooks">
      <div className="toolbar">
        <input className="mb-search" type="search" placeholder={`Search in ${sel ? sel.split(" / ").pop() : "all"}: title, author, tag, year…`}
          value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search books" />
        <label className="small"><input type="checkbox" checked={onlyFile} onChange={(e) => setOnlyFile(e.target.checked)} /> has PDF/EPUB</label>
        <span className="muted small">{shown.length} books
          {data.updated > 0 && <> · Zotero synced {new Date(data.updated * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</>}
        </span>
      </div>
      {data.books.length === 0 && <p className="muted">No Zotero books yet — the Mac sync (tools/zotero_books_sync.py) hasn't uploaded the list.</p>}
      <div className="mb-layout">
        <nav className="mb-side" aria-label="Zotero folders">
          <button className={`mb-folder mb-all ${sel === "" ? "sel" : ""}`} onClick={() => setFolder("")}>All <span className="muted small">{data.books.length}</span></button>
          <Tree nodes={tree} sel={sel} open={opened} onSel={pick} onToggle={toggle} />
        </nav>
        <div className="mb-content">
          {sel && <div className="mb-crumbs">
            {sel.split(" / ").map((part, i, a) => {
              const p = a.slice(0, i + 1).join(" / ");
              return <span key={p}>{i > 0 && " / "}<button className="mb-crumb" onClick={() => pick(p)}>{part}</button></span>;
            })}
          </div>}
          {shown.length === 0 && <p className="muted">Nothing here{q && " for this search"}.</p>}
          {groupList.map(([path, books]) => (
            <section key={path} className="mb-group">
              {groupList.length > 1 && <h3 className="mb-group-title">{rel(path) || "(this folder)"} <span className="muted small">{books.length}</span></h3>}
              <ul className="mb-list">
                {books.slice(0, 400).map((b) => (
                  <li key={b.key} className="mb-row">
                    <div className="mb-main">
                      <div className="mb-title">{b.title}</div>
                      <div className="muted small">
                        {[b.authors.slice(0, 2).join("; "), b.year].filter(Boolean).join(" · ")}
                        {b.attachment && <>{(b.authors.length || b.year) ? " · " : ""}{b.attachment.format.toUpperCase()}</>}
                      </div>
                      {(b.error || busy[b.key]) && busy[b.key] !== "…" && <div className="error small">{b.error || busy[b.key]}</div>}
                    </div>
                    {b.status === "converting" ? <span className="mb-state">{progressText(b.progress)}
                        {b.audiobook && b.progress?.stage === "tts" && b.progress.done > 0 &&
                          <button className="ask mb-listen" onClick={() => onListen(b.audiobook!)}>▶ Listen</button>}</span>
                      : b.audiobook ? <button className="ask mb-listen" onClick={() => onListen(b.audiobook!)}>▶ Listen</button>
                      : b.status === "requested" ? <span className="mb-state" title="Your Mac sends the file within ~10 min (it has to be awake)">Requested · Mac sends it within ~10 min</span>
                      : b.file_on_mac ? <button className="ask" disabled={busy[b.key] === "…"} onClick={() => void make(b)}>
                          {b.status === "error" ? "Retry audiobook" : "Make audiobook"}</button>
                      : <span className="muted small">no file</span>}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
