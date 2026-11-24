import { useState } from "react";
import { Notice, Toolbar, ago, postJson, useJson } from "./common";
import { navigate } from "./route";
import type { PanelProps } from "./common";

interface Reading { last_read: number; att?: string; page: number | null; pages: number | null; percent: number | null }
interface Book { key: string; title: string; authors: string[]; year: string; collections: string[]; tags: string[];
  attachment: { key?: string; format: string } | null; reading: Reading | null; audiobook: string | null; status: string | null;
  readable?: boolean }
interface Shelf { books: Book[]; updated: number }

const RECENT_DAYS = 30;
const ACTIONS: [string, string][] = [["What I'm reading", "Look at the Books panel (books recently opened in Zotero) and recap, for each book I'm reading, where I am and what it covers so far"]];

const shelf = (b: Book) => {
  const c = b.collections.find((x) => /BOOKS/i.test(x)) ?? b.collections[0] ?? "";
  return c.split(" / ").slice(1).join(" › ") || c;
};

function BookCard({ b, onMsg, onAsk }: { b: Book; onMsg: (m: string) => void; onAsk: PanelProps["onAsk"] }) {
  const r = b.reading!;
  const [asked, setAsked] = useState(false);
  const [opening, setOpening] = useState(false);
  const pct = r.percent ?? null;
  const att = r.att ?? b.attachment?.key;
  const zot = att ? `zotero://open-pdf/library/items/${att}${r.page ? `?page=${r.page}` : ""}` : null;
  return (
    <article className="card book">
      <div className="card-head">
        <b className="book-title">{b.title}</b>
        <button className="ask small" onClick={() => onAsk(`Book: ${b.title.slice(0, 50)}`,
          `${b.title}\n${b.authors.join("; ")}\nShelf: ${shelf(b)}\nLast opened ${new Date(r.last_read * 1000).toLocaleDateString()}, page ${r.page ?? "?"}${r.pages ? ` of ${r.pages}` : ""}`)}>Ask agent</button>
      </div>
      <div className="muted small">{[b.authors.slice(0, 2).join(", "), b.year, shelf(b)].filter(Boolean).join(" · ")}</div>
      <div className="book-progress">
        {pct !== null && <div className="progress"><span style={{ width: `${Math.max(2, pct)}%` }} /></div>}
        <span className="small">{r.page ? `p. ${r.page}${r.pages ? ` / ${r.pages}` : ""}` : "opened"}{pct !== null ? ` · ${pct}%` : ""}
          <span className="muted"> · last opened {ago(r.last_read * 1000)}</span></span>
      </div>
      <div className="book-open small">
        {b.readable && b.attachment?.format === "pdf" && <button className="linkish small" disabled={opening} onClick={async () => {
          setOpening(true);
          const r = await fetch(`/api/bookshelf/${b.key}/read`, { method: "POST" });
          const j = await r.json().catch(() => null) as { id?: string; detail?: string } | null;
          setOpening(false);
          if (!j?.id) { onMsg(j?.detail ?? `Could not open (HTTP ${r.status})`); return; }
          navigate("reading", [j.id]);
        }}>{opening ? "Opening…" : "Read here"}</button>}
        {b.readable && b.attachment?.format === "epub" && <a href={`/api/bookshelf/${b.key}/file`}>Download EPUB</a>}
        {zot && <a href={zot} title="Opens the book in the Zotero app on this computer, at your page; progress and notes stay in Zotero">Open in Zotero</a>}
      </div>
      <div className="small">
        {b.audiobook ? <span className="muted">🎧 audiobook ready (Audiobooks)</span>
          : b.status ? <span className="muted">🎧 audiobook {b.status}</span>
          : b.attachment && <button className="linkish small" disabled={asked} onClick={async () => {
            setAsked(true);
            const err = await postJson(`/api/bookshelf/${b.key}/audiobook`, {});
            onMsg(err ?? `Audiobook requested for “${b.title}”. The Mac sends the file within ~10 min.`);
          }}>Make audiobook</button>}
      </div>
    </article>
  );
}

export function Books({ onAsk, onPrompt }: PanelProps) {
  const s = useJson<Shelf>("/api/bookshelf");
  const [msg, setMsg] = useState<string | null>(null);
  const opened = (s.data?.books ?? []).filter((b) => b.reading).sort((a, b) => b.reading!.last_read - a.reading!.last_read);
  const cutoff = Date.now() / 1000 - RECENT_DAYS * 86400;
  const recent = opened.filter((b) => b.reading!.last_read >= cutoff);
  const earlier = opened.filter((b) => b.reading!.last_read < cutoff);
  return (
    <div className="books">
      <Toolbar reload={s.reload} actions={ACTIONS} onPrompt={onPrompt} />
      <Notice msg={msg} onClear={() => setMsg(null)} />
      {s.error && <p className="error">{s.error}</p>}
      {s.data && (
        <>
          <p className="muted small">From Zotero (books under “6. BOOKS” and book items): the ones you opened most recently, with the page
            Zotero remembers. The Mac updates this every 10 minutes{s.data.updated ? ` · last update ${ago(s.data.updated * 1000)}` : ""}.</p>
          <h2 className="section-title">Reading now <span className="muted small">opened in the last {RECENT_DAYS} days · {recent.length}</span></h2>
          {recent.length === 0 && <p className="muted">No book opened in Zotero in the last {RECENT_DAYS} days.</p>}
          <div className="cards">{recent.map((b) => <BookCard key={b.key} b={b} onMsg={setMsg} onAsk={onAsk} />)}</div>
          {earlier.length > 0 && (
            <details className="card"><summary><b>Earlier</b> <span className="muted small">{earlier.length} books opened before</span></summary>
              <ul className="filelist">{earlier.map((b) => (
                <li key={b.key}>{b.title} <span className="muted small">· {shelf(b)} · {b.reading!.page ? `p. ${b.reading!.page}` : ""}
                  {b.reading!.percent !== null ? ` (${b.reading!.percent}%)` : ""} · {ago(b.reading!.last_read * 1000)}</span></li>))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}
