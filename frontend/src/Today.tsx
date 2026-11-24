import { useState } from "react";
import { ProjectLinksInline, ReplyableNote, SortableCards, resetCardOrder } from "./Cards";
import { CheckItem, Inline, Markdown, Notice, Toolbar, ago, postJson, useJson } from "./common";
import type { Check, PanelProps } from "./common";
import { TimelineSection } from "./Timeline";
import { QuestionsCard } from "./Annotations";

interface Section { title: string; line: number; kind: string; items: Check[]; quote: string; last_line: number; last_raw: string }
interface Entry { date: string; title: string; line: number; sections: Section[] }
interface Daily { available: boolean; path: string; mtime: number; today: string; entries: Entry[] }
interface Tasks { dashboard: { header: string[]; rows: string[][] }; updated: string | null; mtime: number;
  groups: { title: string; milestones: { title: string; status: string | null; date: string | null; items: Check[] }[] }[] }

const LAYOUT_KEY = "cardOrder:today";
/** Priority as a small dot in front of the task: 🔴 red, 🟡 yellow, 🔵 (low) none; the emoji is dropped from the text. */
const prioOf = (text: string, ms?: string | null): "red" | "yellow" | null =>
  text.includes("🔴") || ms === "🔴" ? "red" : text.includes("🟡") || ms === "🟡" ? "yellow" : null;
const stripPrio = (text: string) => text.replace(/[🔴🟡🔵]\uFE0F?\s*/gu, "");
function PrioDot({ p }: { p: "red" | "yellow" | null }) {
  return p ? <span className={`prio-dot ${p}`} title={p === "red" ? "Urgent / important (🔴)" : "Medium (🟡)"} /> : null;
}

const ageDays = (iso: string | null, today: string) =>
  iso ? Math.round((new Date(`${today}T12:00:00`).getTime() - new Date(`${iso}T12:00:00`).getTime()) / 86_400_000) : null;

const ACTIONS: [string, string][] = [  // sent to the agent right away (Today passes onRun)
  ["Plan my day", "Plan my day: pick today's 1-3 most urgent tasks from research_tasks.md and timeline.md and add them to today's entry in daily_tracker.md"],
  ["Show tasks", "Show the research_tasks.md dashboard and all open 🔴🟡 tasks"],
];

function MessageBox({ section, onSaved, onError }: { section: Section; onSaved: () => void; onError: (m: string) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const err = await postJson("/api/edit/daily-message", {
      path: "daily_tracker.md", line: section.line, end_line: section.last_line, end_raw: section.last_raw, text,
    });
    setBusy(false);
    if (err) onError(err); else setText("");
    onSaved();
  };
  return (
    <div className="note-line">
      <input value={text} onChange={(e) => setText(e.target.value)} aria-label="Note for Claude"
        placeholder="Note for tomorrow's 7:00 Claude (nothing urgent)…"
        onKeyDown={(e) => { if (e.key === "Enter" && text.trim() && !busy) void save(); }} />
      <button onClick={save} disabled={busy || !text.trim()}>Leave note</button>
    </div>
  );
}

/** the user's own notes for today: double-click to edit (or clear) them. */
function MyNotes({ section, onSaved, onError, editable }: { section: Section; onSaved: () => void; onError: (m: string) => void;
  editable: boolean }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(section.quote);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const err = await postJson("/api/edit/daily-message/replace", { line: section.line, end_line: section.last_line,
      end_raw: section.last_raw, text });
    setBusy(false);
    if (err) { onError(err); return; }
    setEditing(false); onSaved();
  };
  if (editing) return (
    <div className="reply">
      <textarea autoFocus rows={Math.min(8, text.split("\n").length + 1)} value={text} aria-label="Your notes"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") setEditing(false); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save(); }} />
      <div className="toolbar">
        <button onClick={() => void save()} disabled={busy}>Save</button>
        <button className="linkish" onClick={() => { setText(section.quote); setEditing(false); }}>Cancel</button>
        <span className="muted small">Empty + Save clears today's notes</span>
      </div>
    </div>
  );
  return (
    <div className="small my-notes-text" title={editable ? "Double-click to edit" : undefined}
      onDoubleClick={editable ? () => { setText(section.quote); setEditing(true); } : undefined}>
      <span className="muted">Your notes{editable ? " (double-click to edit)" : ""}: </span>
      <Markdown text={section.quote} base="daily_tracker.md" />
    </div>
  );
}

/** One-line input at the end of Today's tasks (replaces the "(add your own here)" placeholder line). */
function AddOwnTask({ onAdd }: { onAdd: (t: string) => Promise<void> }) {
  const [t, setT] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    const v = t.trim();
    if (!v || busy) return;
    setBusy(true);
    await onAdd(v);
    setT("");
    setBusy(false);
  };
  return (
    <div className="add-own">
      <span className="add-own-box" aria-hidden="true">+</span>
      <input value={t} onChange={(e) => setT(e.target.value)} placeholder="Add your own task… (Enter)" aria-label="Add your own task"
        disabled={busy} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void go(); } }} />
      {t.trim() && <button className="linkish small" disabled={busy} onClick={() => void go()}>Add</button>}
    </div>
  );
}

export function Today({ onAsk, onPrompt, onReply, onRun }: PanelProps) {
  const [layout, setLayout] = useState(0);
  const daily = useJson<Daily>("/api/daily");
  const tasks = useJson<Tasks>("/api/tasks");
  const annot = useJson<{ blocks: unknown[]; pending: number }>("/api/annotations");
  const links = useJson<Record<string, Record<string, string>>>("/api/project-links").data;
  const [pick, setPick] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  const reload = () => { daily.reload(); tasks.reload(); };

  const d = daily.data;
  const entry = d?.entries[pick];
  const isToday = entry?.date === d?.today;
  const today = d?.today ?? new Date().toISOString().slice(0, 10);
  // All open tasks (any priority) from research_tasks.md; 🔴 milestones / items are "urgent" (red dot, listed first).
  const red = (tasks.data?.groups ?? []).filter((g) => !/archive|progress log/i.test(g.title)).flatMap((g) => g.milestones
    .filter((m) => m.status !== "✅")
    // "(the advisor)" / "(co-advisor)" / "(Claude)" items are someone else's action items: kept in the tracker, not the user's to-do list
    .flatMap((m) => m.items.filter((i) => !i.checked && !/^(?:[A-Z]-[\w.-]+\s+)?\((?:the advisor|co-advisor|Claude)\)/.test(i.text)).map((i) => ({
      ...i, ms: m.title, msStatus: m.status, age: ageDays(m.date, today), urgent: m.status === "🔴" || i.text.includes("🔴") }))))
    .sort((x, y) => Number(y.urgent) - Number(x.urgent) || (x.age ?? 9999) - (y.age ?? 9999));
  const dash = tasks.data?.dashboard;
  const nextCol = dash ? dash.header.findIndex((h) => /next/i.test(h)) : -1;
  // Tasks already on today's list (by task ID at the start of the line), so "+ Today" can hide for them.
  const todayTasks = (d?.entries[0]?.date === today ? d.entries[0].sections.find((x) => x.kind === "tasks")?.items : []) ?? [];
  const idOf = (t: string) => (t.match(/^([A-Z]{1,4}-(?:MEET\d{3,4}-\d+|[A-Z]{1,6}-\d+[a-z]?|\d+(?:\.\d+)+))\s/) ?? [])[1];
  const ID_ANY = /\b[A-Z]{1,4}-(?:MEET\d{3,4}-\d+|[A-Z]{1,6}-\d+[a-z]?|\d+(?:\.\d+)+)\b/g;
  const onToday = new Set(todayTasks.flatMap((x) => x.text.match(ID_ANY) ?? []));
  const addToday = async (text: string) => {
    const err = await postJson("/api/today/task", { text });
    setMsg(err ?? `Added to today: ${text.slice(0, 60)}`);
    daily.reload();
  };
  const item = (i: (typeof red)[number]) => (
    <div key={`${i.line}-${i.raw}`} className="open-task" draggable={isToday} title={isToday ? "Drag onto Today's tasks to do it today" : undefined} onDragStart={(e) => { e.dataTransfer.setData("text/x-task", i.text); e.dataTransfer.effectAllowed = "copy"; }}>
      <CheckItem path="research_tasks.md" item={i} onDone={tasks.reload} onError={setMsg}>
        <PrioDot p={i.urgent ? "red" : prioOf(i.text, i.msStatus)} />
        <Inline text={stripPrio(i.text)} base="research_tasks.md" />
        <span className="muted small"> · {stripPrio(i.ms.replace(/→.*$/, "")).trim()}{i.age !== null ? ` · ${i.age}d ago` : ""}</span>
      </CheckItem>
      {onToday.has(idOf(i.text) ?? "") && <span className="muted small add-today on">on today</span>}
    </div>
  );

  return (
    <div className="today">
      <Toolbar reload={reload} actions={ACTIONS} onPrompt={onRun ?? onPrompt}>
        {d && d.entries.length > 1 && (
          <select value={pick} onChange={(e) => setPick(Number(e.target.value))} aria-label="Day">
            {d.entries.map((e, i) => <option key={e.date} value={i}>{e.title}</option>)}
          </select>
        )}
        <button className="linkish small" title="Put the cards back in their default order" onClick={() => { resetCardOrder(LAYOUT_KEY); setLayout((n) => n + 1); }}>Reset layout</button>
      </Toolbar>
      <Notice msg={msg} onClear={() => setMsg(null)} />
      {daily.error && <p className="error">{daily.error}</p>}
      {d && !d.available && <p className="muted">daily_tracker.md not found.</p>}
      {d && entry && pick === 0 && !isToday && (
        <p className="banner">No entry for today ({d.today}) yet — the daily check job writes one at 7:00.
          Showing {entry.date}. <button className="linkish" onClick={() => onPrompt(ACTIONS[0][1])}>Ask the agent to create today's entry</button></p>
      )}
      {(() => {
        const cards: { id: string; wide?: boolean; label: string; node: React.ReactNode }[] = [];
        const msgSection = pick === 0 ? entry?.sections.find((s) => s.kind === "message") : undefined;
        const saveNote = msgSection ? async (block: string, reply: string) => {
          const ref = block.replace(/^([-*+]|\d+[.)])\s+/, "").replace(/[*`_>]/g, "").split("\n")[0].slice(0, 50);
          const err = await postJson("/api/edit/daily-message", { path: "daily_tracker.md", line: msgSection.line,
            end_line: msgSection.last_line, end_raw: msgSection.last_raw, text: `Re "${ref}": ${reply}` });
          daily.reload();
          return err;
        } : undefined;
        for (const s of entry?.sections ?? []) {
          if (!entry) break;
          if (s.kind === "tasks" || s.kind === "habits") {
            const drop = s.kind === "tasks" && pick === 0 && isToday;
            // "(add your own here)" is a placeholder, not a task: today it becomes an input box, other days it is hidden
            const isPh = (t: string) => /add your own here/.test(t);
            const items = s.kind === "tasks" ? s.items.filter((i) => !isPh(i.text)) : s.items;
            const done = items.filter((i) => i.checked).length;
            cards.push({ id: s.kind, label: s.kind === "tasks" ? "Today's tasks" : "Habits", node: (
              <section className={`card${drop ? " drop-target" : ""}`}
                onDragOver={drop ? (e) => { if (e.dataTransfer.types.includes("text/x-task")) { e.preventDefault(); e.currentTarget.classList.add("over"); } } : undefined}
                onDragLeave={drop ? (e) => e.currentTarget.classList.remove("over") : undefined}
                onDrop={drop ? (e) => { e.preventDefault(); e.currentTarget.classList.remove("over");
                  const t = e.dataTransfer.getData("text/x-task"); if (t) void addToday(t); } : undefined}>
                <div className="card-head"><h2>{s.kind === "tasks" ? "Today's tasks" : "Habits"}</h2>
                  <span className="muted small">{done}/{items.length}{s.kind === "tasks" ? " · picked by Claude at 7:00; drag tasks in from / back to All open" : ""}</span>
                  <button className="ask" onClick={() => onAsk(`${entry.date} ${s.title}`, s.items.map((i) => `- [${i.checked ? "x" : " "}] ${i.text}`).join("\n"))}>Ask agent</button>
                </div>
                <div className="progress"><span style={{ width: `${items.length ? (100 * done) / items.length : 0}%` }} /></div>
                {items.map((i) => {
                  const movable = drop;
                  return (
                    <div key={`${i.line}-${i.raw}`} className={movable ? "today-task" : undefined} draggable={movable}
                      title={movable ? "Drag back onto All open tasks to take it off today" : undefined}
                      onDragStart={movable ? (e) => { e.dataTransfer.setData("text/x-today", JSON.stringify({ line: i.line, expect: i.raw })); e.dataTransfer.effectAllowed = "move"; } : undefined}>
                      <CheckItem path="daily_tracker.md" item={i} onDone={daily.reload} onError={setMsg}>
                        {s.kind === "tasks" && <PrioDot p={prioOf(i.text)} />}
                        <Inline text={s.kind === "tasks" ? stripPrio(i.text) : i.text} base="daily_tracker.md" />
                      </CheckItem>
                    </div>);
                })}
                {drop && <AddOwnTask onAdd={addToday} />}
              </section>) });
          }
        }
        const reply = entry?.sections.find((x) => x.kind === "reply");
        const mine = entry?.sections.find((x) => x.kind === "message");
        if (entry && (reply || mine)) cards.push({ id: "claude-note", label: "Claude's note", node: (
          <section className="card">
            <div className="card-head"><h2>Claude's note</h2></div>
            {reply?.quote ? <ReplyableNote text={reply.quote} base="daily_tracker.md" label={`Claude's note (${entry.date}, daily_tracker.md)`}
              onReply={onReply} onSaveNote={saveNote} /> : <p className="muted small">No note yet: the 7:00 check writes it.</p>}
            {mine && (mine.quote || pick === 0) && (
              <div className="my-notes">
                {mine.quote && <MyNotes section={mine} onSaved={daily.reload} onError={setMsg} editable={pick === 0} />}
                {pick === 0 && <MessageBox section={mine} onSaved={daily.reload} onError={setMsg} />}
              </div>
            )}
          </section>) });
        if ((annot.data?.blocks?.length ?? 0) > 0) cards.push({ id: "questions", label: "Questions for you",
          node: <QuestionsCard onAsk={onAsk} onPrompt={onPrompt} onError={setMsg} /> });
        cards.push({ id: "timeline", wide: true, label: "Timeline", node: <section className="card"><TimelineSection onError={setMsg} /></section> });
        if (tasks.error) cards.push({ id: "urgent", label: "Most urgent", node: <p className="error">{tasks.error}</p> });
        if (tasks.data) {
          if (dash && nextCol >= 0 && dash.rows.length > 0) cards.push({ id: "focus", label: "Current focus", node: (
            <section className="card">
              <div className="card-head"><h2>Current focus</h2><span className="muted small">Dashboard</span></div>
              {dash.rows.map((r, k) => (
                <p key={k} className="small"><b>{r[0]}</b><ProjectLinksInline all={links} name={r[0]} /> — <Inline text={r[nextCol] ?? ""} base="research_tasks.md" /></p>
              ))}
            </section>) });
          const removeToday = async (raw: string) => {
            try {
              const { line, expect } = JSON.parse(raw) as { line: number; expect: string };
              const err = await postJson("/api/today/task/remove", { line, expect });
              setMsg(err ?? "Taken off today's list.");
            } catch { /* not ours */ }
            daily.reload();
          };
          cards.push({ id: "urgent", label: "All open tasks", node: (
            <section className={`card${isToday ? " drop-target" : ""}`}
              onDragOver={isToday ? (e) => { if (e.dataTransfer.types.includes("text/x-today")) { e.preventDefault(); e.currentTarget.classList.add("over"); } } : undefined}
              onDragLeave={isToday ? (e) => e.currentTarget.classList.remove("over") : undefined}
              onDrop={isToday ? (e) => { e.preventDefault(); e.currentTarget.classList.remove("over");
                const t = e.dataTransfer.getData("text/x-today"); if (t) void removeToday(t); } : undefined}>
              <div className="card-head"><h2>All open tasks</h2><span className="muted small"><PrioDot p="red" /> urgent first · <PrioDot p="yellow" /> medium · drag onto Today's tasks to do it today</span></div>
              <p className="muted small">From research_tasks.md (updated {tasks.data.updated ?? "?"}, file synced {ago(tasks.data.mtime)})
                {(ageDays(tasks.data.updated, today) ?? 0) > 3 && <b className="error"> — the task list is out of date; it syncs every night at 23:30, or ask the agent to sync tasks</b>}</p>
              <div className="scroll-list">
                {red.length === 0 ? <p className="muted small">None.</p> : red.map(item)}
              </div>
            </section>) });
        }
        return <SortableCards key={layout} storageKey={LAYOUT_KEY} items={cards} />;
      })()}
    </div>
  );
}
