import { useEffect, useState } from "react";
import { CheckItem, FileView, Inline, Markdown, Notice, Toolbar, postJson, useJson, when } from "./common";
import type { Check, PanelProps } from "./common";
import { addToReading } from "./Reading";
import { useSubRoute } from "./route";

interface Paper { title: string; line: number; read: Check | null; fields: Record<string, string>;
  links: { label: string; path: string; anchor: string | null }[]; body: string; doi: string | null }
interface FileRef { name: string; path: string; mtime: number }
interface Lit { digests: string[]; digest: string | null; path?: string; intro: string;
  groups: { title: string; papers: Paper[] }[]; notes: FileRef[]; reading_log: FileRef[] }

const ACTIONS: [string, string][] = [
  ["Score this week's papers", "Score this week's papers: read literature-radar/config.yaml and the newest literature-radar/candidates/*-raw.json, rate each paper (Directly relevant / Methods to borrow / Background / Not relevant) with a one-line summary and its link to my projects, and write literature-radar/digests/<date>-weekly.md grouped by rating, with a '- [ ] read' checkbox under each title and clickable DOI links"],
  ["Summarize papers", "Summarize papers: from the newest weekly digest, take the Directly relevant and Methods to borrow papers and write a numbered quick summary of each (what it does, method, link to my projects, worth a deep read?) to literature-radar/reading-notes/<date>-summaries.md; link each summary from the digest"],
];
const VIEWS = ["Radar", "Reading notes", "Zotero log", "Settings"] as const;
const VIEW_SLUGS = ["radar", "notes", "zotero", "settings"];

interface Group { id: string; query: string; project: string }
interface Author { name: string; id: string; tier: string }
interface RadarCfg { keyword_groups: Group[]; tracked_authors: Author[]; venues: { tier1: string[]; tier2: string[] };
  areas: string[]; lookback_days: number; projects: string[]; tiers: string[] }

export const groupEn = (t: string) => t;
export const introEn = (t: string) => t;
const LINK_EN: Record<string, string> = {};
const summaryOf = (f: Record<string, string>) => f["One-line summary"] ?? f.Summary ?? "";

const lines = (t: string) => t.split("\n").map((x) => x.trim()).filter(Boolean);

/** Radar settings = the editable part of literature-radar/config.yaml (radar runs Mondays 7:00). */
function RadarSettings({ onMsg }: { onMsg: (m: string) => void }) {
  const r = useJson<RadarCfg>("/api/literature/config");
  const [cfg, setCfg] = useState<RadarCfg | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (r.data) setCfg(r.data); }, [r.data]);
  if (r.error) return <p className="error">{r.error}</p>;
  if (!cfg) return <p className="muted">Loading…</p>;
  const set = (patch: Partial<RadarCfg>) => setCfg({ ...cfg, ...patch });
  const group = (i: number, patch: Partial<Group>) => set({ keyword_groups: cfg.keyword_groups.map((g, k) => (k === i ? { ...g, ...patch } : g)) });
  const author = (i: number, patch: Partial<Author>) => set({ tracked_authors: cfg.tracked_authors.map((a, k) => (k === i ? { ...a, ...patch } : a)) });
  const save = async () => {
    setBusy(true);
    const err = await postJson("/api/literature/config", { config: cfg });
    setBusy(false);
    if (err) onMsg(err); else { onMsg("Saved to literature-radar/config.yaml — the next radar run (Monday 7:00) uses it."); r.reload(); }
  };
  return (
    <section className="card trends-settings lit-settings">
      <h3>Keyword groups</h3>
      <p className="muted small">Each group is one Semantic Scholar search per week. A paper is kept when at least 2 words of a group
        (about two-thirds of a longer query) appear in its title or abstract, so use 2–5 specific words.</p>
      {cfg.keyword_groups.map((g, i) => (
        <div key={i} className="topic-row lit-group">
          <input aria-label="Group name" placeholder="name (auto)" value={g.id} onChange={(e) => group(i, { id: e.target.value })} />
          <input aria-label={`Search query for ${g.id}`} placeholder="search words" value={g.query} onChange={(e) => group(i, { query: e.target.value })} />
          <select aria-label={`Project for ${g.id}`} value={g.project} onChange={(e) => group(i, { project: e.target.value })}>
            {cfg.projects.map((p) => <option key={p} value={p}>{p}</option>)}</select>
          <button className="linkish" onClick={() => set({ keyword_groups: cfg.keyword_groups.filter((_, k) => k !== i) })}>Remove</button>
        </div>
      ))}
      <button onClick={() => set({ keyword_groups: [...cfg.keyword_groups, { id: "", query: "", project: "all" }] })}>+ Add keyword group</button>

      <h3>Tracked authors</h3>
      <p className="muted small">New papers by these people are pulled every week. Leave the Semantic Scholar ID blank and the next run looks it up
        by name (it picks the namesake with the most papers — check the ID afterwards for common names).
        Tier: S = weekly, A = monthly, self = citations of your own work.</p>
      <div className="table-wrap"><table className="sections">
        <thead><tr><th>Name</th><th>Semantic Scholar ID</th><th>Tier</th><th /></tr></thead>
        <tbody>{cfg.tracked_authors.map((a, i) => (
          <tr key={i}>
            <td><input aria-label="Author name" value={a.name} onChange={(e) => author(i, { name: e.target.value })} /></td>
            <td className="lit-id"><input aria-label={`Semantic Scholar ID for ${a.name}`} value={a.id} placeholder="auto" inputMode="numeric"
              onChange={(e) => author(i, { id: e.target.value.trim() })} />
              {a.id && <a className="small" href={`https://www.semanticscholar.org/author/${a.id}`} target="_blank" rel="noreferrer">check</a>}</td>
            <td><select aria-label={`Tier for ${a.name}`} value={a.tier} onChange={(e) => author(i, { tier: e.target.value })}>
              {cfg.tiers.map((t) => <option key={t} value={t}>{t}</option>)}</select></td>
            <td><button className="linkish" onClick={() => set({ tracked_authors: cfg.tracked_authors.filter((_, k) => k !== i) })}>Remove</button></td>
          </tr>
        ))}</tbody>
      </table></div>
      <button onClick={() => set({ tracked_authors: [...cfg.tracked_authors, { name: "", id: "", tier: "A" }] })}>+ Add author</button>

      <h3>Venues</h3>
      <p className="muted small">One per line. Papers from tier 1 / tier 2 venues are marked T1 / T2 and ranked first.</p>
      <div className="lit-venues">
        <label className="small">Tier 1<textarea aria-label="Tier 1 venues" rows={6} value={cfg.venues.tier1.join("\n")}
          onChange={(e) => set({ venues: { ...cfg.venues, tier1: e.target.value.split("\n") } })}
          onBlur={() => set({ venues: { ...cfg.venues, tier1: lines(cfg.venues.tier1.join("\n")) } })} /></label>
        <label className="small">Tier 2<textarea aria-label="Tier 2 venues" rows={6} value={cfg.venues.tier2.join("\n")}
          onChange={(e) => set({ venues: { ...cfg.venues, tier2: e.target.value.split("\n") } })}
          onBlur={() => set({ venues: { ...cfg.venues, tier2: lines(cfg.venues.tier2.join("\n")) } })} /></label>
      </div>

      <h3>Research areas</h3>
      <p className="muted small">One per line. Claude reads these when it scores the week's papers (directly relevant / methods to borrow / background / not relevant).</p>
      <textarea aria-label="Research areas" rows={5} value={cfg.areas.join("\n")}
        onChange={(e) => set({ areas: e.target.value.split("\n") })} onBlur={() => set({ areas: lines(cfg.areas.join("\n")) })} />

      <h3>Look-back window</h3>
      <label className="small">Search papers published in the last{" "}
        <input type="number" min={1} max={60} aria-label="Look-back days" style={{ width: 64 }} value={cfg.lookback_days}
          onChange={(e) => set({ lookback_days: Number(e.target.value) })} /> days</label>

      <div className="toolbar"><button onClick={() => void save()} disabled={busy}>Save settings</button>
        <button className="linkish" onClick={() => { if (r.data) setCfg(r.data); }}>Discard changes</button></div>
    </section>
  );
}

export function Literature({ onAsk, onPrompt }: PanelProps) {
  const [digest, setDigest] = useState<string | null>(null);
  const lit = useJson<Lit>(`/api/literature${digest ? `?digest=${encodeURIComponent(digest)}` : ""}`);
  // The tab is part of the address: #/literature/radar | notes | zotero | settings
  const [sub, setSub] = useSubRoute("literature");
  const view = VIEWS[Math.max(0, VIEW_SLUGS.indexOf(sub[0] ?? ""))];
  const setView = (v: (typeof VIEWS)[number]) => setSub(v === "Radar" ? [] : [VIEW_SLUGS[VIEWS.indexOf(v)]]);
  const [open, setOpen] = useState<{ path: string; anchor?: string | null } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const d = lit.data;
  const papers = d?.groups.flatMap((g) => g.papers) ?? [];
  const unread = papers.filter((p) => p.read && !p.read.checked).length;

  const files = (list: FileRef[]) => (
    <ul className="filelist">
      {list.map((f) => (
        <li key={f.path}><button className="linkish" onClick={() => setOpen({ path: f.path })}>{f.name}</button>
          <span className="muted small"> · {when(f.mtime)}</span></li>
      ))}
    </ul>
  );

  return (
    <div className="literature">
      <Toolbar reload={lit.reload} actions={ACTIONS} onPrompt={onPrompt}>
        <div className="subnav sub2" role="tablist">
          {VIEWS.map((v) => <button key={v} role="tab" aria-selected={v === view} className={v === view ? "active" : ""}
            onClick={() => { setView(v); setOpen(null); }}>{v}</button>)}
        </div>
      </Toolbar>
      <Notice msg={msg} onClear={() => setMsg(null)} />
      {lit.error && <p className="error">{lit.error}</p>}
      {open && <FileView path={open.path} anchor={open.anchor} onClose={() => setOpen(null)} />}

      {d && view === "Radar" && !open && (
        <>
          <div className="toolbar">
            <select value={d.digest ?? ""} onChange={(e) => setDigest(e.target.value)} aria-label="Week">
              {d.digests.map((n) => <option key={n} value={n}>{n.replace("-weekly.md", "")}</option>)}
            </select>
            <span className="muted small">{unread}/{papers.length} unread</span>
          </div>
          {d.intro && <Markdown text={introEn(d.intro)} base={d.path} />}
          {d.groups.map((g) => (
            <section key={g.title}>
              <h2 className="section-title">{groupEn(g.title)} <span className="muted small">{g.papers.length}</span></h2>
              <div className="cards">
                {g.papers.map((p) => (
                  <article key={p.line} className={`card paper ${p.read?.checked ? "is-read" : ""}`}>
                    <div className="card-head"><h3 className="paper-title">{p.title}</h3></div>
                    <div className="small muted">{p.fields.Authors}</div>
                    <div className="small">{p.fields.Venue}{p.doi && <> · <a href={p.doi} target="_blank" rel="noreferrer">DOI</a></>}</div>
                    {summaryOf(p.fields) && <p className="small"><Inline text={summaryOf(p.fields)} /></p>}
                    {p.body && <details className="small"><summary>Relevance to projects / notes</summary><Markdown text={p.body} base={d.path} /></details>}
                    <div className="paper-actions">
                      {p.read && d.path && <CheckItem path={d.path} item={p.read} onDone={lit.reload} onError={setMsg}>Read</CheckItem>}
                      {p.links.map((l) => <button key={l.path + l.label} className="linkish" onClick={() => setOpen({ path: l.path, anchor: l.anchor })}>{LINK_EN[l.label] ?? l.label}</button>)}
                      <button className="ask" onClick={async () => {
                        const err = await addToReading({ title: p.title, authors: p.fields.Authors ?? "", venue: p.fields.Venue ?? "",
                          url: p.doi ?? "", doi: p.doi ?? "", source: "radar" });
                        if (err) setMsg(err);
                      }}>Read</button>
                      <button className="ask" onClick={() => onAsk(p.title, `${p.title}\n${p.fields.Authors ?? ""}\n${p.fields.Venue ?? ""}\n${p.doi ?? ""}\n${summaryOf(p.fields)}\n${p.body}`)}>Ask agent</button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))}
          {d.groups.length === 0 && <p className="muted">No digest yet — the radar runs Mondays 7:00.</p>}
        </>
      )}
      {d && view === "Reading notes" && !open && files(d.notes)}
      {d && view === "Zotero log" && !open && (d.reading_log.length ? files(d.reading_log) : <p className="muted">No reading log files.</p>)}
      {view === "Settings" && !open && <RadarSettings onMsg={setMsg} />}
    </div>
  );
}
