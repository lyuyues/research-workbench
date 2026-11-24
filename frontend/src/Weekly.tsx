import { useState } from "react";
import { FileView, Toolbar, hm, useJson } from "./common";
import type { PanelProps } from "./common";

interface Week { week_start: string; week_end: string; today: string; total_minutes: number;
  entries: { date: string; project: string; task: string; minutes: number }[];
  by_project: { project: string; minutes: number }[]; by_day: { date: string; minutes: number }[];
  habits: { habit: string; done: number; of: number }[]; reports: { name: string; path: string }[] }

const ACTIONS: [string, string][] = [
  ["Generate weekly update", "weekly update"],
  ["Time this week", "Show this week's time from time_log.jsonl as a table by project and task, with the total hours"],
  ["Weekly progress", "Summarise this week: habits from daily_tracker.md, deep-work hours from time_log.jsonl, compared with last week"],
];
const shift = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function Weekly({ onAsk, onPrompt }: PanelProps) {
  const [week, setWeek] = useState<string | null>(null);
  const { data, error, reload } = useJson<Week>(`/api/weekly${week ? `?week=${week}` : ""}`);
  const [open, setOpen] = useState<string | null>(null);
  const max = Math.max(1, ...(data?.by_project.map((p) => p.minutes) ?? [1]));
  const maxDay = Math.max(1, ...(data?.by_day.map((p) => p.minutes) ?? [1]));
  const summary = data ? `Week ${data.week_start}–${data.week_end}: ${hm(data.total_minutes)} total. ` +
    data.by_project.map((p) => `${p.project} ${hm(p.minutes)}`).join(", ") + "\n" +
    data.entries.map((e) => `${e.date} [${e.project}] ${e.task} (${e.minutes}m)`).join("\n") : "";

  return (
    <div className="weekly">
      <Toolbar reload={reload} actions={ACTIONS} onPrompt={onPrompt}>
        {data && (
          <span className="weeknav">
            <button onClick={() => setWeek(shift(data.week_start, -7))} aria-label="Previous week">‹</button>
            <b>{data.week_start} – {data.week_end}</b>
            <button onClick={() => setWeek(shift(data.week_start, 7))} disabled={data.week_end >= data.today} aria-label="Next week">›</button>
          </span>
        )}
      </Toolbar>
      {error && <p className="error">{error}</p>}
      {open && <FileView path={open} onClose={() => setOpen(null)} />}
      {data && !open && (
        <>
          <div className="cards">
            <section className="card">
              <div className="card-head"><h2>Time by project</h2><span className="muted small">{hm(data.total_minutes)}</span>
                <button className="ask" onClick={() => onAsk(`Time ${data.week_start}`, summary)}>Ask agent</button></div>
              {data.by_project.length === 0 && <p className="muted">No time logged this week (time_log.jsonl).</p>}
              {data.by_project.map((p) => (
                <div key={p.project} className="bar-row">
                  <span className="bar-label">{p.project}</span>
                  <span className="bar"><span style={{ width: `${(100 * p.minutes) / max}%` }} /></span>
                  <span className="small">{hm(p.minutes)}</span>
                </div>
              ))}
            </section>
            <section className="card">
              <div className="card-head"><h2>By day</h2></div>
              <div className="days">
                {data.by_day.map((d, i) => (
                  <div key={d.date} className={`day ${d.date === data.today ? "today" : ""}`} title={`${d.date}: ${hm(d.minutes)}`}>
                    <span className="day-bar"><span style={{ height: `${(100 * d.minutes) / maxDay}%` }} /></span>
                    <span className="small">{DOW[i]}</span>
                    <span className="small muted">{d.minutes ? hm(d.minutes) : ""}</span>
                  </div>
                ))}
              </div>
            </section>
            <section className="card">
              <div className="card-head"><h2>Habits</h2></div>
              {data.habits.length === 0 ? <p className="muted small">No daily_tracker entries this week.</p> : data.habits.map((h) => (
                <div key={h.habit} className="bar-row">
                  <span className="bar-label">{h.habit}</span>
                  <span className="bar"><span style={{ width: `${(100 * h.done) / Math.max(1, h.of)}%` }} /></span>
                  <span className="small">{h.done}/{h.of}</span>
                </div>
              ))}
            </section>
          </div>
          {data.entries.length > 0 && (
            <details className="card"><summary><b>{data.entries.length} logged tasks</b></summary>
              <div className="table-wrap"><table><tbody>{data.entries.map((e, i) => (
                <tr key={i}><td className="small muted">{e.date}</td><td className="small">{e.project}</td><td>{e.task}</td><td className="small">{hm(e.minutes)}</td></tr>
              ))}</tbody></table></div>
            </details>
          )}
          <h2 className="section-title">Weekly reports</h2>
          <ul className="filelist">{data.reports.map((r) => (
            <li key={r.path}><button className="linkish" onClick={() => setOpen(r.path)}>{r.name}</button></li>
          ))}</ul>
        </>
      )}
    </div>
  );
}
