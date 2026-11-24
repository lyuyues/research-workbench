import { useState } from "react";
import { useJson } from "./common";
import { MyBooks } from "./MyBooks";

import { mmss, useAudio } from "./AudioDock";
import type { Book, Chapter, Progress } from "./AudioDock";

interface Overview { feeds: { books?: string | null; research?: string | null }; books: Book[] }

const FEED_LABEL = { books: "Books · private", research: "Research · shareable" } as const;

/** Copies a feed URL; if the clipboard API is unavailable, shows the URL to copy by hand. */
function CopyLink({ url, label = "Copy link" }: { url: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setState("copied");
      setTimeout(() => setState("idle"), 2000);
    } catch {
      setState("manual");
    }
  };
  return (
    <span className="ab-copy">
      <button className="ask" onClick={() => void copy()}>{state === "copied" ? "Copied ✓" : label}</button>
      {state === "manual" && <input className="ab-url" readOnly value={url} onFocus={(e) => e.currentTarget.select()} autoFocus aria-label="Feed URL" />}
    </span>
  );
}

export function Audiobooks() {
  const [tab, setTab] = useState<"listen" | "books">("listen");
  const { data, error, reload } = useJson<Overview>("/api/audiobooks");
  const prog = useJson<Progress>("/api/audiobooks/progress");
  const audio = useAudio();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const progress: Progress = { ...(prog.data ?? {}), ...audio.saved };
  const playing = audio.now ? { slug: audio.now.book.slug, file: audio.now.file } : null;
  if (error) return <p className="error" role="alert">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const play = (b: Book, c: Chapter) => {
    const p = progress[b.slug];
    audio.play(b, c.file, p && p.file === c.file ? p.pos : 0);
  };
  const resume = (b: Book) => {
    const p = progress[b.slug];
    const c = (p && b.chapters.find((x) => x.file === p.file && x.ready)) || b.chapters.find((x) => x.ready);
    if (c) play(b, c);
  };
  const listenTo = (slug: string) => {
    const b = data.books.find((x) => x.slug === slug);
    setTab("listen");
    if (b) { setOpen((o) => ({ ...o, [slug]: true })); resume(b); }
  };
  const groups = (["books", "research"] as const).map((f) => ({ feed: f, books: data.books.filter((b) => b.feed === f) }));
  return (
    <div className="audiobooks">
      <div className="subnav sub2 ab-tabs" role="tablist" aria-label="Audiobooks">
        <button role="tab" aria-selected={tab === "listen"} className={tab === "listen" ? "active" : ""} onClick={() => setTab("listen")}>Listen</button>
        <button role="tab" aria-selected={tab === "books"} className={tab === "books" ? "active" : ""} onClick={() => setTab("books")}>My books</button>
      </div>
      {tab === "books" ? <MyBooks onListen={listenTo} /> : <>
      <div className="toolbar">
        <span className="muted small">
          Podcast app → Library → ⋯ → Follow a Show by URL → paste. Episodes remember where you stopped.
        </span>
        <button onClick={reload}>Refresh</button>
      </div>
      <section className="card ab-all">
        <div className="card-head"><h2>All-in-one feeds</h2></div>
        <p className="muted small">New books appear here automatically. Each book is a season.</p>
        {(["books", "research"] as const).map((f) => (
          <div key={f} className="ab-row">
            <span>{f === "books" ? "the user's Audiobooks" : "the user's Research Briefs"} <span className="muted small">· {FEED_LABEL[f]}</span></span>
            {data.feeds[f] ? <CopyLink url={data.feeds[f]!} /> : <span className="muted small">no token</span>}
          </div>
        ))}
      </section>
      {groups.map(({ feed, books }) => books.length > 0 && (
        <section key={feed}>
          <h3 className="ab-group">{FEED_LABEL[feed]} — one feed per book</h3>
          <ul className="ab-list">
            {books.map((b) => (
              <li key={b.slug} className="card ab-book">
                <div className="ab-head">
                  <div className="ab-main">
                    <div className="ab-title">{b.title}</div>
                    <div className="muted small">
                      {b.author && <>{b.author} · </>}
                      {b.complete ? `${b.episodes} episodes · ${b.hours} h` : `converting ${b.ready}/${b.episodes} · ${b.hours} h so far`}
                    </div>
                  </div>
                  <button className="ask ab-resume" disabled={b.ready === 0} onClick={() => resume(b)}>
                    {(() => {
                      const p = progress[b.slug];
                      const c = p && b.chapters.find((x) => x.file === p.file);
                      return c ? `▶ Continue · ${c.n} (${mmss(p.pos)})` : "▶ Start";
                    })()}
                  </button>
                  <button className="ask" aria-expanded={!!open[b.slug]} onClick={() => setOpen((o) => ({ ...o, [b.slug]: !o[b.slug] }))}>
                    {open[b.slug] ? "Hide episodes" : "Episodes"}
                  </button>
                  {b.feed_url && <CopyLink url={b.feed_url} />}
                </div>
                {open[b.slug] && (
                  <ol className="ab-eps">
                    {b.chapters.map((c) => {
                      const cur = playing?.slug === b.slug && playing.file === c.file;
                      return (
                        <li key={c.file} className={cur ? "current" : ""}>
                          <button className="ab-ep" disabled={!c.ready} onClick={() => play(b, c)}>
                            <span className="ab-n">{cur ? "♪" : c.n}</span>
                            <span className="ab-ep-title">{c.title}</span>
                            <span className="muted small">{c.ready ? mmss(c.duration) : "…"}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {data.books.length === 0 && <p className="muted">No audiobooks yet — pick one under “My books”.</p>}
      </>}
    </div>
  );
}
