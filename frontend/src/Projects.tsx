import { useState } from "react";
import { CheckItem, Inline, Markdown, Notice, Toolbar, ago, useJson } from "./common";
import type { Check, PanelProps } from "./common";
import { ProjectLinksInline } from "./Cards";

interface Milestone { title: string; line: number; items: Check[]; notes: string[]; open: number; done: number; status: string | null }
interface Group { title: string; line: number; milestones: Milestone[] }
interface Tasks { available: boolean; updated: string | null; mtime: number;
  dashboard: { header: string[]; rows: string[][] }; groups: Group[]; log: { title: string; text: string }[] }
interface Stage { id: string; name: string; status: string; summary?: string; start?: string; end?: string }
interface Timeline { headline?: string; stages: Stage[]; events: { date: string; kind: string; title: string; stage?: string }[]; generated_at?: string }
interface Portfolio { available: boolean; generated_at?: string; headline?: string;
  issues?: { severity: string; title: string; detail: string; suggestion?: string }[];
  links?: { from: string; to: string; kind: string; label: string; detail?: string }[];
  timelines: Record<string, Timeline> }

// Task sync runs every night (23:30), so no button for it. The timeline refresh is slow (minutes) and only
// offered when the snapshot is more than 7 days old.
const REFRESH: [string, string] = ["Refresh project timelines (a few min)",
  "For every project in projects.yaml, summarise status, milestones and risks from its files and research_tasks.md, and update _tracker/"];

const stale = (d?: string) => !!d && (Date.now() - new Date(d).getTime()) / 86_400_000 > 7;

export function Projects({ onAsk, onPrompt }: PanelProps) {
  const tasks = useJson<Tasks>("/api/tasks");
  const pf = useJson<Portfolio>("/api/portfolio");
  const links = useJson<Record<string, Record<string, string>>>("/api/project-links").data;
  const [msg, setMsg] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const t = tasks.data, p = pf.data;

  return (
    <div className="projects">
      <Toolbar reload={() => { tasks.reload(); pf.reload(); }}
        actions={p && (!p.available || !p.generated_at || stale(p.generated_at)) ? [REFRESH] : []} onPrompt={onPrompt}>
        <label className="small"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> show done</label>
      </Toolbar>
      <Notice msg={msg} onClear={() => setMsg(null)} />
      {tasks.error && <p className="error">{tasks.error}</p>}

      {t?.available && (
        <section className="card">
          <div className="card-head"><h2>Dashboard</h2>
            <span className="muted small">updated {t.updated ?? "?"} · synced {ago(t.mtime)}</span></div>
          <div className="table-wrap"><table>
            <thead><tr>{t.dashboard.header.map((h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{t.dashboard.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}><Inline text={c} base="research_tasks.md" />{j === 0 && <ProjectLinksInline all={links} name={c} />}</td>)}</tr>)}</tbody>
          </table></div>
        </section>
      )}

      {p?.available && Object.keys(p.timelines).length > 0 && (
        <>
          <h2 className="section-title">Timeline <span className="muted small">tracker snapshot {p.generated_at ?? "?"}
            {stale(p.generated_at) && " — out of date, click “Refresh project timelines” above"}</span></h2>
          <div className="cards">
            {Object.entries(p.timelines).map(([name, tl]) => (
              <section key={name} className="card">
                <div className="card-head"><h2>{name}</h2><ProjectLinksInline all={links} name={name} />
                  <button className="ask" onClick={() => onAsk(`${name} timeline`, JSON.stringify(tl, null, 1).slice(0, 6000))}>Ask agent</button></div>
                {tl.headline && <p className="small">{tl.headline}</p>}
                <ol className="stages">
                  {tl.stages.map((s) => (
                    <li key={s.id} className={`stage st-${s.status}`} title={s.summary}>
                      <b>{s.id}</b> {s.name}<span className="small muted"> · {s.status}</span>
                      {s.summary && <div className="small muted">{s.summary}</div>}
                    </li>
                  ))}
                </ol>
                {tl.events.length > 0 && (
                  <details className="small"><summary>{tl.events.length} recent events</summary>
                    <ul>{[...tl.events].reverse().slice(0, 15).map((e, i) => <li key={i}><span className="muted">{e.date}</span> {e.title}</li>)}</ul>
                  </details>
                )}
              </section>
            ))}
          </div>
          {(p.issues?.length ?? 0) > 0 && (
            <details className="card"><summary><b>Cross-project issues ({p.issues!.length})</b> <span className="muted small">from the {p.generated_at} snapshot</span></summary>
              <ul>{p.issues!.map((i, k) => <li key={k}><b>[{i.severity}]</b> {i.title}<div className="small muted">{i.suggestion ?? i.detail}</div></li>)}</ul>
            </details>
          )}
        </>
      )}

      {t?.groups.map((g) => (
        <section key={g.line}>
          <h2 className="section-title">{g.title}</h2>
          <div className="cards">
            {g.milestones.filter((m) => showDone || m.open > 0).map((m) => (
              <details key={m.line} className="card milestone" open={m.status === "🔴" || m.status === "🟡"}>
                <summary>
                  <Inline text={m.title || "(tasks)"} base="research_tasks.md" />
                  <span className="muted small"> · {m.open} open{m.done ? ` / ${m.done} done` : ""}</span>
                </summary>
                {m.items.filter((i) => showDone || !i.checked).map((i) => (
                  <CheckItem key={`${i.line}-${i.raw}`} path="research_tasks.md" item={i} onDone={tasks.reload} onError={setMsg}>
                    <Inline text={i.text} base="research_tasks.md" />
                  </CheckItem>
                ))}
                {m.notes.map((n, k) => <p key={k} className="small muted"><Inline text={n} base="research_tasks.md" /></p>)}
                <button className="ask" onClick={() => onAsk(m.title, m.items.map((i) => `- [${i.checked ? "x" : " "}] ${i.text}`).join("\n"))}>Ask agent</button>
              </details>
            ))}
          </div>
        </section>
      ))}

      {t && t.log.length > 0 && (
        <>
          <h2 className="section-title">Progress log</h2>
          {t.log.map((e, i) => (
            <details key={i} className="card" open={i === 0}>
              <summary><b>{e.title}</b></summary>
              <Markdown text={e.text} base="research_tasks.md" />
            </details>
          ))}
        </>
      )}
    </div>
  );
}
