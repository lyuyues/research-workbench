import { useCallback, useEffect, useState } from "react";

export interface LogEntry {
  ts: number; actor: string; action: string; detail?: string;
  panel?: string; files?: string[]; commit?: string; seconds?: number;
}

const ACTOR: Record<string, string> = {
  "claude-mac": "Claude (Mac)", agent: "Platform agent", job: "Scheduled job", user: "You (web)", system: "System",
};
const FILTERS = ["all", "claude-mac", "agent", "job", "user", "system"] as const;

const fmt = (ts: number) =>
  new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function SystemLog() {
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");

  const load = useCallback(() => {
    fetch("/api/oplog?limit=500")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setEntries((await r.json()) as LogEntry[]);
        setError(null);
      })
      .catch((e: unknown) => setError(`Could not load the log (${e instanceof Error ? e.message : String(e)})`));
  }, []);
  useEffect(load, [load]);

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!entries) return <p className="muted">Loading…</p>;
  const shown = filter === "all" ? entries : entries.filter((e) => e.actor === filter);
  return (
    <div>
      <div className="toolbar">
        <div className="subnav sub2" role="tablist" aria-label="Who">
          {FILTERS.map((f) => (
            <button key={f} role="tab" aria-selected={f === filter} className={f === filter ? "active" : ""} onClick={() => setFilter(f)}>
              {f === "all" ? "All" : ACTOR[f]}
            </button>
          ))}
        </div>
        <button onClick={load}>Refresh</button>
      </div>
      {shown.length === 0 && <p className="muted">No entries.</p>}
      <ol className="oplog">
        {shown.map((e, i) => (
          <li key={`${e.ts}-${i}`} className={`op ${/fail/i.test(e.action) ? "failed" : ""}`}>
            <span className="muted small op-time">{fmt(e.ts)}</span>
            <span className={`op-actor a-${e.actor}`}>{ACTOR[e.actor] ?? e.actor}</span>
            <span className="op-action">{e.action}</span>
            {e.panel && <span className="muted small"> · {e.panel}</span>}
            {e.seconds !== undefined && <span className="muted small"> · {e.seconds}s</span>}
            {e.detail && <div className="op-detail">{e.detail}</div>}
            {e.files && e.files.length > 0 && (
              <details className="small"><summary>{e.files.length} file(s)</summary>
                <ul>{e.files.map((f) => <li key={f}>{f}</li>)}</ul></details>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
