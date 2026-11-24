import { useState } from "react";
import { Publish } from "./PaperPublish";
import { FileView, Toolbar, ago, useJson } from "./common";
import type { PanelProps } from "./common";

interface Section { name: string; path: string; words: number; todos: number; status: string; mtime: number }
interface Paper { name: string; overleaf: string | null; sections: Section[]; docs: { path: string; mtime: number }[]; words: number; pdf: string | null }

const ACTIONS: [string, string][] = [["Next writing step", "Look at the paper drafts in the Writing panel and suggest which section to work on next, and why"]];
const LABEL: Record<string, string> = { empty: "Empty", stub: "Stub", draft: "Draft", written: "Written" };
const days = (ms: number) => { const d = Math.floor((Date.now() - ms) / 86_400_000); return d < 1 ? "today" : `${d}d`; };

export function Writing({ onAsk, onPrompt, readOnly = false }: PanelProps & { readOnly?: boolean }) {
  const { data, error, reload } = useJson<{ papers: Paper[] }>("/api/writing");
  const [open, setOpen] = useState<string | null>(null);
  const [pub, setPub] = useState<string | null>(null);
  return (
    <div className="writing">
      <Toolbar reload={reload} actions={readOnly ? [] : ACTIONS} onPrompt={onPrompt}>
        <span className="muted small">Word counts are estimates. Empty &lt;30 words · Stub &lt;300 · Draft = has TODOs.</span>
      </Toolbar>
      {error && <p className="error">{error}</p>}
      {pub && <Publish project={pub} onClose={() => { setPub(null); reload(); }} />}
      {open && !pub && <FileView path={open} onClose={() => setOpen(null)} />}
      {data && !open && !pub && (
        <div className="cards one">
          {data.papers.map((p) => {
            const recent = [...p.sections].sort((a, b) => b.mtime - a.mtime)[0];
            return (
              <section key={p.name} className="card">
                <div className="card-head"><h2>{p.name}</h2>
                  <span className="muted small">≈{p.words.toLocaleString()} words</span>
                  {p.overleaf && <a className="ask" href={p.overleaf} target="_blank" rel="noreferrer">Overleaf ↗</a>}
                  {!readOnly && <a className="ask" href={`#/pdf/${p.name}`} target="_blank" rel="noreferrer">Live PDF ↗</a>}
                  {!readOnly && <button className="ask" onClick={() => setPub(p.name)}>Publish clean version to Overleaf…</button>}
                </div>
                {recent && <p className="small muted">Last edited: {recent.name} · {ago(recent.mtime)}</p>}
                <div className="table-wrap"><table className="sections">
                  <thead><tr><th>Section</th><th>Words</th><th>Status</th><th>TODO</th><th>Edited</th>{!readOnly && <th />}</tr></thead>
                  <tbody>{p.sections.map((s) => (
                    <tr key={s.path}>
                      <td><button className="linkish" onClick={() => setOpen(s.path)}>{s.name.replace(/\.tex$/, "")}</button></td>
                      <td className="num">{s.words}</td>
                      <td><span className={`status w-${s.status}`}>{LABEL[s.status]}</span></td>
                      <td>{s.todos || ""}</td>
                      <td className="small muted nowrap">{days(s.mtime)}</td>
                      {!readOnly && <td><button className="ask small" onClick={() => onAsk(`${p.name} ${s.name}`, `Paper ${p.name}, section file ${s.path} (${s.words} words, ${s.todos} TODOs).`)}>Ask</button></td>}
                    </tr>
                  ))}</tbody>
                </table></div>
                {p.docs.length > 0 && <div className="small">Key docs: {p.docs.map((d) =>
                  <button key={d.path} className="linkish" onClick={() => setOpen(d.path)}>{d.path.split("/").pop()}</button>)}</div>}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
