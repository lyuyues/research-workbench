import { useState } from "react";
import { CheckItem, Inline, useJson } from "./common";

interface Item { line: number; raw: string; checkbox: boolean; checked: boolean; date: string; time: string | null;
  title: string; note: string | null; tags: string[]; done: boolean; days: number; overdue: boolean; text?: string; link?: string | null }
interface Group { title: string; line: number; target: string | null; days: number | null; items: Item[]; source?: string; error?: string | null;
  progress?: { done: number; total: number; due: number; overdue: number; next: Item | null } }
interface GoogleStatus { configured: boolean; expires_at?: number | null; error?: string | null }
interface View { available: boolean; path: string; today: string; groups: Group[]; google?: GoogleStatus }

const PALETTE = ["#2f5bd3", "#d9822b", "#2a9d8f", "#8a5cc7", "#c2402d", "#5b6b7f", "#b58a12", "#d6457a"];
const KEY = "rp:tl-topics";
const PAST_KEY = "rp:tl-past";
const fmt = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", weekday: "short" });
const month = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { year: "numeric", month: "long" });
const when = (d: number) => d === 0 ? "today" : d === 1 ? "tomorrow" : d > 0 ? `in ${d}d` : `${-d}d ago`;
const dayMs = (iso: string) => new Date(`${iso}T12:00:00`).getTime();

function loadSet(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(KEY) ?? "[]") as string[]); } catch { return new Set(); }
}

function Strip({ g, today }: { g: Group; today: string }) {
  const ms = g.items.filter((i) => i.checkbox);
  if (!g.target || ms.length === 0) return null;
  const start = Math.min(dayMs(ms[0].date), dayMs(today));
  const end = dayMs(g.target);
  const pos = (iso: string) => `${Math.max(0, Math.min(100, (100 * (dayMs(iso) - start)) / Math.max(1, end - start)))}%`;
  return (
    <div className="tl-strip" aria-hidden>
      <span className="tl-line" />
      <span className="tl-today" style={{ left: pos(today) }} title={`today ${today}`} />
      {ms.map((i) => (
        <span key={i.line} className={`tl-dot ${i.done ? "done" : i.overdue ? "late" : ""}`} style={{ left: pos(i.date) }}
          title={`${i.date} ${i.title}`} />
      ))}
    </div>
  );
}

type Row = Item & { group: Group };

/** One merged timeline (paper tracks, events, venues, Google Calendar…) filtered by clickable topics. */
export function TimelineSection({ onError }: { onError: (m: string) => void }) {
  const tl = useJson<View>("/api/timeline");
  const [picked, setPicked] = useState<Set<string>>(loadSet);
  const [past, setPast] = useState(() => { try { return localStorage.getItem(PAST_KEY) === "1"; } catch { return false; } });
  const v = tl.data;
  if (tl.error) return <p className="error">{tl.error}</p>;
  if (!v || !Array.isArray(v.groups)) return null;
  if (!v.available && !v.groups.length) return <p className="muted small">No timeline.md yet: ask the agent to add dates.</p>;

  const topics = v.groups.map((g, n) => ({ g, color: PALETTE[n % PALETTE.length] }));
  const color = new Map(topics.map((t) => [t.g.title, t.color]));
  const live = [...picked].filter((t) => color.has(t));
  const shown = live.length ? topics.filter((t) => live.includes(t.g.title)) : topics;
  const save = (s: Set<string>) => { setPicked(s); try { localStorage.setItem(KEY, JSON.stringify([...s])); } catch { /* ignore */ } };
  const toggle = (t: string) => { const s = new Set(live); if (s.has(t)) s.delete(t); else s.add(t); save(s); };
  const setPastP = (b: boolean) => { setPast(b); try { localStorage.setItem(PAST_KEY, b ? "1" : "0"); } catch { /* ignore */ } };

  const items: Row[] = shown.flatMap(({ g }) => g.items.map((i) => ({ ...i, group: g })))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
  const overdue = items.filter((i) => i.overdue);
  const list = items.filter((i) => !i.overdue && (past || i.days >= -1));
  const hidden = items.filter((i) => !i.overdue && !past && i.days < -1).length;
  const tracks = shown.filter(({ g }) => g.target && g.progress);
  const gs = v.google;
  const expiresIn = gs?.expires_at ? Math.round((gs.expires_at * 1000 - Date.now()) / 86400000) : null;

  const row = (i: Row) => {
    const dot = <span className="tl-topic-dot" style={{ background: color.get(i.group.title) }} title={i.group.title} />;
    const title = i.link ? <a href={i.link} target="_blank" rel="noreferrer">{i.title}</a> : <Inline text={i.title} base={v.path} />;
    const body = (
      <span className="tl-title">{dot}{title}
        {i.note && <span className="muted small"> — {i.link ? i.note : <Inline text={i.note} base={v.path} />}</span>}
        {live.length !== 1 && <span className="muted small"> · {i.group.title}</span>}</span>
    );
    const cls = `tl-row ${i.done ? "done" : ""} ${i.overdue ? "late" : ""} ${i.days < 0 && !i.checkbox ? "past" : ""}`;
    return (
      <div key={`${i.group.title}${i.line}`} className={cls}>
        <span className="tl-date">{fmt(i.date)}{i.time ? ` ${i.time}` : ""}</span>
        <span className="tl-when">{i.done ? "done" : when(i.days)}</span>
        {i.checkbox
          ? <CheckItem path={v.path} item={{ ...i, text: i.title }} onDone={tl.reload} onError={onError}>{body}</CheckItem>
          : body}
      </div>
    );
  };

  const out: React.ReactNode[] = [];
  let lastMonth = "";
  for (const i of list) {
    const m = month(i.date);
    if (m !== lastMonth) { out.push(<h3 key={`m-${m}`} className="tl-month">{m}</h3>); lastMonth = m; }
    out.push(row(i));
  }

  return (
    <>
      <h2 className="section-title">Timeline <span className="muted small">from {v.path}{gs?.configured ? " + Google Calendar" : ""} · edit the file or ask the agent</span></h2>
      <section className="card tl-card">
        <div className="tl-topics" role="group" aria-label="Topics">
          <button className={`chip ${live.length === 0 ? "on" : ""}`} onClick={() => save(new Set())}>All</button>
          {topics.map(({ g, color: c }) => (
            <button key={g.title} className={`chip ${live.includes(g.title) ? "on" : ""}`} aria-pressed={live.includes(g.title)}
              onClick={() => toggle(g.title)} onDoubleClick={() => save(new Set([g.title]))}
              title="Click to add / remove · double-click to show only this">
              <span className="tl-topic-dot" style={{ background: c }} />{g.title}
              <span className="muted small"> {g.items.filter((i) => i.days >= 0 && !i.done).length}</span>
            </button>
          ))}
          <label className="small muted tl-past"><input type="checkbox" checked={past} onChange={(e) => setPastP(e.target.checked)} /> show past</label>
        </div>
        {gs && !gs.configured && <p className="muted small">Google Calendar not connected: run <code>python3 deploy/google_login.py ~/Downloads/rp_google_client.json</code> on the Mac.</p>}
        {gs?.configured && (gs.error || (expiresIn !== null && expiresIn <= 1)) && (
          <p className="error small">{gs.error ?? `Google sign-in expires ${expiresIn! <= 0 ? "today" : "tomorrow"}`} — run <code>python3 deploy/google_login.py ~/Downloads/rp_google_client.json</code> on the Mac.</p>
        )}
        {shown.filter(({ g }) => g.error).map(({ g }) => <p key={g.title} className="error small">{g.title}: {g.error}</p>)}

        {tracks.length > 0 && (
          <div className="tl-tracks">
            {tracks.map(({ g, color: c }) => {
              const p = g.progress!;
              return (
                <div key={g.title} className="tl-track">
                  <div className="tl-track-head">
                    <b><span className="tl-topic-dot" style={{ background: c }} />{g.title}</b>
                    <span className="small muted">{fmt(g.target!)} · {g.days! >= 0 ? `${g.days}d left` : "past"} · {p.done}/{p.total} done · </span>
                    {p.overdue > 0 ? <b className="error small">{p.overdue} behind</b> : <span className="tl-ok small">on track</span>}
                  </div>
                  <Strip g={g} today={v.today} />
                </div>
              );
            })}
          </div>
        )}

        {overdue.length > 0 && <div className="tl-overdue"><div className="small error">Overdue</div>{overdue.map(row)}</div>}
        {list.length === 0 && overdue.length === 0 && <p className="muted small">Nothing in these topics.</p>}
        {out}
        {hidden > 0 && <button className="linkish small" onClick={() => setPastP(true)}>{hidden} past entries hidden — show</button>}
      </section>
    </>
  );
}
