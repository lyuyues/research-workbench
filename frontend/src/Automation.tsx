import { useCallback, useEffect, useState } from "react";

interface Job {
  name: string; title: string; schedule: string; next_run: number; running: boolean;
  last_start: number | null; last_end: number | null; rc: number | null; last_ok: number | null;
  reason: string | null; log_tail: string; output: string; requested: boolean;
  status: "ok" | "failed" | "stale" | "never" | "running";
}
interface MacJob { title: string; schedule: string; last_activity: number | null; log_tail: string; status: string }
interface Snapshot {
  jobs: Job[]; mac_jobs: MacJob[]; conflicts: string[];
  nextcloud: { status: string; last_ok?: number; last_end?: number; rc?: number; message?: string };
}

const when = (ms: number | null | undefined) =>
  ms ? new Date(ms).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
const STATUS: Record<string, string> = { ok: "OK", failed: "Failed", stale: "Overdue", never: "Never run", running: "Running" };

function Badge({ s }: { s: string }) {
  return <span className={`status s-${s}`}>{STATUS[s] ?? s}</span>;
}

export function Automation() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/automation")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setData((await r.json()) as Snapshot);
        setError(null);
      })
      .catch((e: unknown) => setError(`Could not load automation status (${e instanceof Error ? e.message : String(e)})`));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const runNow = async (j: Job) => {
    const r = await fetch(`/api/automation/run/${j.name}`, { method: "POST" }).catch(() => null);
    setNotice(r?.ok ? `${j.title}: queued — starts within a minute.` : `${j.title}: could not queue (${r ? `HTTP ${r.status}` : "network error"})`);
    load();
  };

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const nc = data.nextcloud;
  return (
    <div className="automation">
      <div className="toolbar">
        <span className="muted small">Server jobs run on the server (times in its RP_TZ). Refreshes every 30 s.</span>
        <button onClick={load}>Refresh</button>
      </div>
      {notice && <p className="small" role="status">{notice}</p>}

      <section className="card">
        <h3>Server jobs</h3>
        {data.jobs.map((j) => (
          <div key={j.name} className="job" aria-label={j.title}>
            <div className="job-head">
              <b>{j.title}</b> <Badge s={j.status} />
              <span className="muted small">{j.schedule} · next {when(j.next_run)}</span>
              <button className="ask" onClick={() => runNow(j)} disabled={j.running || j.requested}>
                {j.requested ? "Queued" : "Run now"}
              </button>
            </div>
            <div className="small muted">
              Last run {when(j.last_start)}{j.reason ? ` (${j.reason})` : ""}
              {j.rc !== null && j.rc !== undefined ? ` · exit ${j.rc}` : ""} · last success {when(j.last_ok)}
            </div>
            {(j.log_tail || j.output) && (
              <details className="small"><summary>Log</summary><pre className="transcript">{j.log_tail || j.output}</pre></details>
            )}
          </div>
        ))}
      </section>

      <section className="card">
        <h3>Nextcloud sync</h3>
        <div className="job-head"><b>Research folder ⇄ Nextcloud</b> <Badge s={nc.status} />
          <span className="muted small">every 2 min · last success {when(nc.last_ok)}</span></div>
        {nc.message && <pre className="transcript small">{nc.message}</pre>}
        <div className="small">
          {data.conflicts.length === 0 ? <span className="muted">No conflicted copies.</span> : (
            <>
              <b className="error">{data.conflicts.length} conflicted cop{data.conflicts.length === 1 ? "y" : "ies"}</b> — resolve by hand:
              <ul>{data.conflicts.map((c) => <li key={c}>{c}</li>)}</ul>
            </>
          )}
        </div>
      </section>

      <section className="card">
        <h3>On the Mac</h3>
        {data.mac_jobs.map((m) => (
          <div key={m.title} className="job">
            <div className="job-head"><b>{m.title}</b> <Badge s={m.status} />
              <span className="muted small">{m.schedule} · last activity {when(m.last_activity)}</span></div>
            {m.log_tail && <details className="small"><summary>Log</summary><pre className="transcript">{m.log_tail}</pre></details>}
          </div>
        ))}
      </section>
    </div>
  );
}
