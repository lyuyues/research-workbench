import { useEffect, useState } from "react";

interface FilePlan { path: string; new: boolean; diff: string; leaks: string[]; conflict: boolean }
interface Preview { project: string; digest: string; files: FilePlan[]; pulled: { merged: string[]; conflicts: string[] } }

/** Publish the clean version of the platform draft to Overleaf: preview every change first, then push. */
export function Publish({ project, onClose }: { project: string; onClose: () => void }) {
  const [pv, setPv] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [done, setDone] = useState<string[] | null>(null);
  const load = async () => {
    setPv(null); setErr(null);
    const r = await fetch(`/api/paper/${encodeURIComponent(project)}/preview`);
    const j = await r.json().catch(() => null);
    if (!r.ok) setErr(j?.detail ?? `HTTP ${r.status}`); else setPv(j);
  };
  useEffect(() => { void load(); }, [project]); // eslint-disable-line react-hooks/exhaustive-deps
  const publish = async () => {
    if (!pv) return;
    setBusy(true); setErr(null);
    const r = await fetch(`/api/paper/${encodeURIComponent(project)}/publish`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ digest: pv.digest, message: msg }) });
    const j = await r.json().catch(() => null);
    setBusy(false);
    if (!r.ok) { setErr(j?.detail ?? `HTTP ${r.status}`); return; }
    setDone(j.published);
  };
  const blocked = pv?.files.some((f) => f.leaks.length || f.conflict);
  return (
    <div className="card publish">
      <div className="card-head">
        <h2>{project} → Overleaf</h2>
        <span className="muted small">clean version of the platform draft (Claude's notes, TODOs and questions removed)</span>
        <button className="ask" onClick={onClose}>Close</button>
      </div>
      {err && <p className="error">{err}</p>}
      {!pv && !err && <p className="muted">Merging collaborators' Overleaf edits and preparing the clean version…</p>}
      {done && <p>✓ Published to Overleaf: {done.length ? done.join(", ") : "nothing to publish"}</p>}
      {pv && !done && <>
        {pv.pulled.merged.length > 0 && <p className="small">↓ Merged collaborators' Overleaf edits into the draft: {pv.pulled.merged.join(", ")}</p>}
        {pv.pulled.conflicts.length > 0 && <p className="error small">Conflicting edits (marked &lt;&lt;&lt;&lt;&lt;&lt;&lt; in the draft): {pv.pulled.conflicts.join(", ")} — fix them in the draft first.</p>}
        {pv.files.length === 0 ? <p className="muted">Overleaf already matches the clean draft. Nothing to publish.</p> : <>
          <p className="small">{pv.files.length} file(s) will change on Overleaf. Red = removed on Overleaf, green = added.</p>
          {pv.files.map((f) => (
            <details key={f.path} open={pv.files.length <= 3}>
              <summary><b>{f.path}</b>{f.new && " (new file)"}
                {f.leaks.length > 0 && <span className="error"> · ⚠️ AI trace left: {f.leaks.join(" · ")}</span>}
                {f.conflict && <span className="error"> · unresolved conflict</span>}</summary>
              <pre className="diff">{f.diff.split("\n").map((l, i) =>
                <span key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : ""}>{l}{"\n"}</span>)}</pre>
            </details>
          ))}
          <div className="toolbar">
            <input value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Overleaf commit message (optional)" aria-label="Commit message" />
            <button onClick={() => void publish()} disabled={busy || blocked}>{busy ? "Publishing…" : "Publish to Overleaf"}</button>
            <button className="linkish" onClick={() => void load()}>Refresh preview</button>
          </div>
          {blocked && <p className="error small">Publishing is blocked until the traces / conflicts above are fixed in the draft.</p>}
        </>}
      </>}
    </div>
  );
}
