import { useEffect, useState } from "react";
import { Notice, Toolbar, ago, postJson, useJson } from "./common";
import type { PanelProps } from "./common";
import { addToReading } from "./Reading";
import { Replyable, SortableCards, resetCardOrder } from "./Cards";

interface Topic { id?: string; name: string; keywords: string[] }
interface Source { name: string; url: string; kind: Kind; watch?: "feed" | "page"; all: boolean; enabled: boolean }
interface Config { topics: Topic[]; sources: Source[]; arxiv: { enabled: boolean; categories: string[]; max_per_topic: number };
  hn: { enabled: boolean; min_points: number } }
interface Item { id: string; title: string; url: string; source: string; kind: Kind; published: number | null; snippet: string;
  topics: string[]; authors?: string[]; discussion?: string; zh: string | null; relevance: number | null; why: string | null }
type Saved = Item & { day?: string | null; saved_at: number };
interface View { days: string[]; day: string | null; config: Config | null; items: Item[]; headline: string | null; saved: Saved[];
  errors: { source: string; error: string }[]; generated: number | null; summarized: boolean }
type Kind = "academic" | "lab" | "hcilab" | "industry" | "community";

const KINDS: [Kind | "all", string][] = [["all", "All"], ["academic", "Academic"], ["lab", "AI labs"], ["hcilab", "HCI labs"], ["industry", "Industry"], ["community", "Community"]];
const KIND_LABEL: Record<Kind, string> = { academic: "Academic", lab: "AI lab", hcilab: "HCI lab", industry: "Industry", community: "Community" };
const ACTIONS: [string, string][] = [["Today's highlights", "Look at today's Trends (latest day in trends/data), pick the 5 items most relevant to my research and say why each matters"]];

function Settings({ config, onSaved, onError }: { config: Config | null; onSaved: () => void; onError: (m: string) => void }) {
  const [cfg, setCfg] = useState<Config | null>(config);
  const [busy, setBusy] = useState(false);
  useEffect(() => setCfg(config), [config]);
  if (!cfg) return <p className="muted">No config yet — it is created on the first fetch.</p>;
  const set = (patch: Partial<Config>) => setCfg({ ...cfg, ...patch });
  const topic = (i: number, patch: Partial<Topic>) => set({ topics: cfg.topics.map((t, k) => (k === i ? { ...t, ...patch } : t)) });
  const source = (i: number, patch: Partial<Source>) => set({ sources: cfg.sources.map((s, k) => (k === i ? { ...s, ...patch } : s)) });
  const save = async () => {
    setBusy(true);
    const err = await postJson("/api/trends/config", { config: cfg });
    setBusy(false);
    if (err) onError(err); else onSaved();
  };
  return (
    <section className="card trends-settings">
      <h3>Topics</h3>
      <p className="muted small">One keyword per line or comma-separated. Short all-caps words (AR, VR) match only as whole words in that case. Changes apply from the next fetch.</p>
      {cfg.topics.map((t, i) => (
        <div key={i} className="topic-row">
          <input aria-label="Topic name" value={t.name} onChange={(e) => topic(i, { name: e.target.value })} />
          <textarea aria-label={`Keywords for ${t.name}`} rows={2} value={t.keywords.join(", ")}
            onChange={(e) => topic(i, { keywords: e.target.value.split(/[,\n]/).map((k) => k.trim()).filter(Boolean) })} />
          <button className="linkish" onClick={() => set({ topics: cfg.topics.filter((_, k) => k !== i) })}>Remove</button>
        </div>
      ))}
      <button onClick={() => set({ topics: [...cfg.topics, { name: "New topic", keywords: [] }] })}>+ Add topic</button>

      <h3>Sources</h3>
      <label className="small"><input type="checkbox" checked={cfg.arxiv.enabled} onChange={(e) => set({ arxiv: { ...cfg.arxiv, enabled: e.target.checked } })} /> arXiv, categories{" "}
        <input aria-label="arXiv categories" value={cfg.arxiv.categories.join(", ")}
          onChange={(e) => set({ arxiv: { ...cfg.arxiv, categories: e.target.value.split(/[,\s]+/).filter(Boolean) } })} /></label>
      <label className="small"><input type="checkbox" checked={cfg.hn.enabled} onChange={(e) => set({ hn: { ...cfg.hn, enabled: e.target.checked } })} /> Hacker News, min points{" "}
        <input type="number" aria-label="Hacker News min points" value={cfg.hn.min_points} style={{ width: 70 }}
          onChange={(e) => set({ hn: { ...cfg.hn, min_points: Number(e.target.value) } })} /></label>
      <div className="table-wrap"><table className="sections">
        <thead><tr><th>On</th><th>Name</th><th>URL</th><th title="Feed = RSS / Atom. Page = check a web page daily and list links that are new since the last check (for labs without a feed)">Watch</th><th>Type</th><th title="Keep every post, not only topic matches">All posts</th><th /></tr></thead>
        <tbody>{cfg.sources.map((s, i) => (
          <tr key={i}>
            <td><input type="checkbox" aria-label={`Enable ${s.name}`} checked={s.enabled} onChange={(e) => source(i, { enabled: e.target.checked })} /></td>
            <td><input value={s.name} aria-label="Source name" onChange={(e) => source(i, { name: e.target.value })} /></td>
            <td><input value={s.url} aria-label="Feed URL" style={{ width: "100%" }} onChange={(e) => source(i, { url: e.target.value })} /></td>
            <td><select value={s.watch ?? "feed"} aria-label="Watch as" onChange={(e) => source(i, { watch: e.target.value as "feed" | "page" })}>
              <option value="feed">Feed</option><option value="page">Page</option></select></td>
            <td><select value={s.kind} aria-label="Source type" onChange={(e) => source(i, { kind: e.target.value as Kind })}>
              {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></td>
            <td><input type="checkbox" aria-label={`All posts from ${s.name}`} checked={s.all} onChange={(e) => source(i, { all: e.target.checked })} /></td>
            <td><button className="linkish" onClick={() => set({ sources: cfg.sources.filter((_, k) => k !== i) })}>Remove</button></td>
          </tr>
        ))}</tbody>
      </table></div>
      <button onClick={() => set({ sources: [...cfg.sources, { name: "", url: "https://", kind: "industry", watch: "feed", all: false, enabled: true }] })}>+ Add source</button>
      <div className="toolbar"><button onClick={save} disabled={busy}>Save settings</button></div>
    </section>
  );
}

export function Trends({ onAsk, onPrompt, onReply }: PanelProps) {
  const [layout, setLayout] = useState(0);
  const [day, setDay] = useState<string | null>(null);
  const v = useJson<View>(`/api/trends${day ? `?day=${day}` : ""}`);
  const [kind, setKind] = useState<Kind | "all">("all");
  const [topics, setTopics] = useState<string[]>([]);
  const [relevantOnly, setRelevantOnly] = useState(false);
  const [settings, setSettings] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const d = v.data;
  // "Save for later": a star per item; saved items are kept across days and listed under "Saved".
  const [saved, setSaved] = useState<Saved[] | null>(null);
  useEffect(() => { if (d) setSaved(d.saved ?? []); }, [d]);
  const savedIds = new Set((saved ?? []).map((x) => x.id));
  const [showSaved, setShowSaved] = useState(false);
  const toggleSave = async (x: Item) => {
    const on = !savedIds.has(x.id);
    const prev = saved;
    setSaved((s) => (on ? [{ ...x, day: d?.day, saved_at: Date.now() }, ...(s ?? [])] : (s ?? []).filter((y) => y.id !== x.id)));
    try {
      const r = await fetch("/api/trends/saved", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item: x, saved: on, day: d?.day ?? null }) });
      const j = await r.json().catch(() => null) as { saved?: Saved[]; detail?: unknown } | null;
      if (!r.ok || !j?.saved) throw new Error(typeof j?.detail === "string" ? j.detail : `HTTP ${r.status}`);
      setSaved(j.saved);
    } catch (e) {
      setSaved(prev);
      setMsg(`Could not ${on ? "save" : "unsave"}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const names = new Map((d?.config?.topics ?? []).map((t) => [t.id ?? t.name, t.name]));
  const items = (d?.items ?? [])
    .filter((x) => kind === "all" || x.kind === kind)
    .filter((x) => !topics.length || x.topics.some((t) => topics.includes(t)))
    .filter((x) => !relevantOnly || (x.relevance ?? 0) >= 2)
    .sort((a, b) => (b.relevance ?? -1) - (a.relevance ?? -1) || (b.published ?? 0) - (a.published ?? 0));
  const card = (x: Item | Saved) => (
              <Replyable label={`Trend: ${x.title.slice(0, 60)}`} onReply={onReply}
                context={`Trends item${d?.day ? ` (${d.day})` : ""}:\n${x.title}\n${x.url}\nSource: ${x.source} (${x.kind})\n${x.zh ?? ""}\n${x.snippet}`}>

              <article key={x.id} className={`card trend r${x.relevance ?? "x"}`}>
                <div className="card-head">
                  <a className="trend-title" href={x.url} target="_blank" rel="noreferrer">{x.title}</a>
                  <button className={`save-star${savedIds.has(x.id) ? " on" : ""}`} aria-pressed={savedIds.has(x.id)}
                    aria-label={savedIds.has(x.id) ? "Saved — tap to remove" : "Save for later"} title={savedIds.has(x.id) ? "Saved — click to remove" : "Save for later"}
                    onClick={() => void toggleSave(x)}>{savedIds.has(x.id) ? "★" : "☆"}</button>
                </div>
                <div className="muted small">{x.relevance != null && x.relevance >= 2 &&
                  <span className={`rel-tag r${x.relevance}`} title="How relevant Claude thinks this is to your research">{x.relevance >= 3 ? "Highly relevant" : "Relevant"}</span>}
                  {KIND_LABEL[x.kind]} · {x.source}{x.published ? ` · ${ago(x.published)}` : ""}
                  {(x.topics ?? []).map((t) => <span key={t} className="status"> {names.get(t) ?? t}</span>)}
                  {x.discussion && <> · <a href={x.discussion} target="_blank" rel="noreferrer">discussion</a></>}</div>
                {x.zh ? <p className="small">{x.zh}</p> : <p className="small muted">{x.snippet}</p>}
                {x.why && <p className="small why">↳ {x.why}</p>}
                {(x.kind === "academic" || /arxiv\.org|doi\.org|\.pdf($|\?)/.test(x.url)) && (
                  <button className="ask small" onClick={async () => {
                    const err = await addToReading({ title: x.title, url: x.url, authors: x.authors ?? [], source: "trends" });
                    if (err) setMsg(err);
                  }}>Read</button>)}{" "}
                {!onReply && <button className="ask small" onClick={() => onAsk(`Trend: ${x.title.slice(0, 60)}`,
                  `${x.title}\n${x.url}\nSource: ${x.source} (${x.kind})\n${x.zh ?? ""}\n${x.snippet}`)}>Ask agent</button>}
              </article>
              </Replyable>
  );
  const fetchNow = async () => {
    const err = await postJson("/api/automation/run/daily_trends", {});
    setMsg(err ?? "Fetch requested — it starts within a minute and takes a few minutes (see Automation).");
  };

  return (
    <div className="trends">
      <Toolbar reload={v.reload} actions={ACTIONS} onPrompt={onPrompt}>
        {d && d.days.length > 0 && (
          <select aria-label="Day" value={d.day ?? ""} onChange={(e) => setDay(e.target.value)}>
            {d.days.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        )}
        <button className={showSaved ? "active" : ""} aria-pressed={showSaved} onClick={() => setShowSaved((x) => !x)}>
          ★ Saved {saved?.length ?? 0}</button>
        <button onClick={fetchNow}>Fetch now</button>
        <button className="linkish small" title="Put the items back in their default order (relevance, then newest)" onClick={() => {
          resetCardOrder(showSaved ? "cardOrder:trends:saved" : `cardOrder:trends:${d?.day}`); setLayout((n) => n + 1); }}>Reset order</button>
        <button className={settings ? "active" : ""} onClick={() => setSettings((s) => !s)}>{settings ? "Close settings" : "Topics & sources"}</button>
      </Toolbar>
      <Notice msg={msg} onClear={() => setMsg(null)} />
      {v.error && <p className="error">{v.error}</p>}
      {settings && d && <Settings config={d.config} onError={setMsg} onSaved={() => { setMsg("Saved. The next fetch uses the new topics and sources."); v.reload(); }} />}
      {showSaved && saved && (
        <section>
          <p className="muted small">{saved.length ? `${saved.length} saved for later — newest first. Tap ★ to remove.` : "Nothing saved yet — tap ☆ on an item to keep it here."}</p>
          <SortableCards key={`saved-${layout}`} storageKey="cardOrder:trends:saved" className="trend-list" items={saved.map((x) => ({
            id: x.id, label: x.title.slice(0, 60),
            node: <div>{x.day && <div className="muted small saved-day">from {x.day} · saved {ago(x.saved_at)}</div>}{card(x)}</div> }))} />
        </section>
      )}
      {!showSaved && d && !d.day && <p className="muted">No trends yet. The feed is fetched daily at 6:30 — or press “Fetch now”.</p>}
      {!showSaved && d && d.day && (
        <>
          <p className="muted small">{d.items.length} new items · fetched {d.generated ? ago(d.generated) : "?"}
            {!d.summarized && " · Chinese summaries not written yet"}
            {d.errors.length > 0 && <span title={d.errors.map((e) => `${e.source}: ${e.error}`).join("\n")}> · {d.errors.length} source(s) failed</span>}</p>
          {d.headline && <section className="card"><h3>Today's headline</h3><p>{d.headline}</p></section>}
          <div className="subnav sub2" role="tablist" aria-label="Type">
            {KINDS.map(([k, l]) => {
              const n = k === "all" ? d.items.length : d.items.filter((x) => x.kind === k).length;
              return <button key={k} role="tab" aria-selected={k === kind} className={k === kind ? "active" : ""} onClick={() => setKind(k)}>{l} {n}</button>;
            })}
          </div>
          <div className="toolbar">
            {[...names].map(([id, name]) => (
              <button key={id} className={`chip ${topics.includes(id) ? "active" : ""}`} aria-pressed={topics.includes(id)}
                onClick={() => setTopics((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]))}>{name}</button>
            ))}
            <label className="small"><input type="checkbox" checked={relevantOnly} onChange={(e) => setRelevantOnly(e.target.checked)} /> relevant to my research only</label>
          </div>
          {items.length === 0 && <p className="muted">Nothing matches these filters.</p>}
          <SortableCards key={`${d.day}-${layout}`} storageKey={`cardOrder:trends:${d.day}`} className="trend-list"
            items={items.map((x) => ({ id: x.id, label: x.title.slice(0, 60), node: card(x) }))} />
        </>
      )}
    </div>
  );
}
