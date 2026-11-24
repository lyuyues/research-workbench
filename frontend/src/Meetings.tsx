import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { CheckItem, FileView, Inline, Markdown, Notice, Toolbar, ago, postJson, useJson } from "./common";
import type { Check, PanelProps } from "./common";
import { Replyable, SortableCards, resetCardOrder } from "./Cards";

const LAYOUT_KEY = "cardOrder:meetings";

type Kind = "advisor" | "group";
interface Session { date: string; files: Partial<Record<"slides" | "slack" | "notes" | "zoom" | "recap", string>>; legacy: boolean; status: string;
  recap?: "draft" | "reviewed"; notion?: { pushed_at: number | null; projects: string[]; changed: boolean } | null }
interface KindView { title: string; next: number; next_date: string; current: Session; history: Session[]; last: string | null }
interface Question extends Check { kind: Kind }
interface MeetingsView { kinds: Record<Kind, KindView>; questions: Question[]; questions_path: string;
  action_items: { date: string; items: (Check & { id: string; path?: string })[]; source?: "tasks" | "recap"; draft?: boolean;
    kind?: Kind }[]; now: number }

const STATUS: Record<string, string> = { planned: "Not prepared", prepared: "Slides ready", cancelled: "Cancelled · Slack sent", held: "Held" };
const fmt = (ms: number) => new Date(ms).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
const until = (ms: number, now: number) => {
  const h = Math.round((ms - now) / 3_600_000);
  return h < 0 ? "now" : h < 24 ? `in ${h} h` : `in ${Math.round(h / 24)} d`;
};
const mdd = (iso: string) => `${Number(iso.slice(5, 7))}${iso.slice(8, 10)}`;

export const PROMPTS = {
  advisor: (d: string, last: string | null) =>
    `Prepare the slides for my advisor meeting on ${d}: English Marp markdown, one section per project in projects.yaml. ` +
    `Inputs: the last meeting (${last ?? "none yet"}: notes + slides), the research_tasks.md Progress Log since then, open MEET action items, ` +
    `the "## Advisor" questions in meetings/questions.md. Every "Ask advisors" item must be a decidable question; list assumptions on the last slide. ` +
    `Write meetings/advisor/${d}_slides.md.`,
  group: (d: string) =>
    `Prepare my group meeting update for ${d}: exactly 2 slides in English Marp markdown — (1) "What I have done this week", ` +
    `(2) "What I plan for next week" — one bold line per project with one level of sub-bullets, then a "## Speaking notes" script ` +
    `(1-3 minutes, ~130 words/min). Sources: research_tasks.md Progress Log and ticked tasks since the last group meeting, open tasks, ` +
    `timeline.md. Write meetings/group/${d}_slides.md.`,
  slack: (d: string) =>
    `My advisor meeting on ${d} is cancelled. Write a progress update message instead: English, 150-250 words, Slack formatting ` +
    `(*bold* section labels, bullets) — progress since the last meeting, the decisions I need (meetings/questions.md "## Advisor"), ` +
    `and my plan for next week. Write only the message text to meetings/advisor/${d}_slack.md.`,
  notes: (k: Kind, d: string) =>
    `Process my ${k} meeting notes in meetings/${k}/${d}_notes.md (and the "## Todos" of the reviewed recap meetings/${k}/${d}_recap.md, if any): ` +
    `add my action items to research_tasks.md as <P>-MEET${mdd(d)}-N tasks under the right project (P = the project code in projects.yaml, O = other), ` +
    `tick the questions in meetings/questions.md that were discussed, and add a short entry to the Progress Log. Report what you added.`,
};

function SlackMessage({ path }: { path: string }) {
  const f = useJson<{ text: string }>(`/api/file?path=${encodeURIComponent(path)}`);
  const [copied, setCopied] = useState(false);
  if (!f.data) return null;
  return (
    <div className="slack">
      <div className="card-head"><b className="small">Slack message</b>
        <button className="ask small" onClick={() => { void navigator.clipboard?.writeText(f.data!.text); setCopied(true); }}>{copied ? "Copied" : "Copy"}</button></div>
      <pre className="transcript">{f.data.text}</pre>
    </div>
  );
}

type ActionGroup = MeetingsView["action_items"][number];
const shortDate = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** All meetings' action items in one card: a tab per meeting (newest first), opening on the newest with open items. */
export function ActionItems({ groups, render, title = "Action items", history = false }: { groups: ActionGroup[];
  render: (g: ActionGroup) => ReactNode; title?: string; history?: boolean }) {
  const sorted = [...groups].sort((a, b) => b.date.localeCompare(a.date));
  const firstOpen = sorted.find((g) => g.items.some((i) => !i.checked)) ?? sorted[0];
  const [pick, setPick] = useState<string | null>(null);
  const cur = sorted.find((g) => g.date === pick) ?? firstOpen;
  if (!cur) return (
    <section className="card"><div className="card-head"><h2>{title}</h2></div>
      <p className="muted small">No open action items. After a meeting: review the recap, then “Process notes → tasks”.</p></section>);
  const done = (g: ActionGroup) => g.items.filter((i) => i.checked).length;
  const tabs = (
    <div className="subnav sub2 action-tabs" role="tablist" aria-label="Meeting">
      {sorted.map((g) => {
        const all = g.items.length > 0 && done(g) === g.items.length;
        return <button key={g.date} role="tab" aria-selected={g === cur} className={`${g === cur ? "active" : ""}${all ? " all-done" : ""}`}
          onClick={() => setPick(g.date)}>{shortDate(g.date)} · {done(g)}/{g.items.length}{all ? " ✓" : ""}</button>;
      })}
    </div>);
  if (history) return (
    <details className="card action-history">
      <summary><b>{title}</b> <span className="status s-ok">done</span>
        <span className="muted small"> {sorted.length} meeting{sorted.length === 1 ? "" : "s"}, all items done</span></summary>
      {tabs}
      {render(cur)}
    </details>);
  return (
    <section className="card">
      <div className="card-head"><h2>{title}</h2><span className="muted small">tasks decided in meetings (also in Today's open tasks)</span></div>
      {sorted.length > 1 && tabs}
      {sorted.length === 1 && <div className="muted small">{shortDate(cur.date)} meeting · {done(cur)}/{cur.items.length} done</div>}
      {cur.source === "recap" && <p className="banner small">{cur.draft
        ? "From the recap draft. Review the recap (Meetings → Review recap) and save it: these become tasks in research_tasks.md."
        : "From the reviewed recap. Save the recap once more to add them to research_tasks.md."}</p>}
      {render(cur)}
    </section>
  );
}

type Which = "notes" | "slides" | "slack" | "recap";

/** The Slack / Notion part of a recap (between "## Slack / Notion recap" and the next "## "). */
export function slackPart(md: string): string {
  const m = md.match(/^## Slack \/ Notion recap\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
  return (m ? m[1] : "").trim();
}

/** Readable preview: drop the draft marker; Slack's *bold* inside the Slack section → markdown **bold**. */
export function prettyRecap(md: string): string {
  const body = md.replace(/^<!--[\s\S]*?-->\s*/, "");
  return body.replace(/(^## Slack \/ Notion recap\s*\n)([\s\S]*?)(?=^## |(?![\s\S]))/m, (_all, head: string, sec: string) =>
    head + sec.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,:;!?]|$)/gm, "$1**$2**")
      // Slack keeps every line; markdown would join them. A blank line after each non-list line keeps them apart.
      .split("\n").map((l) => (l.trim() && !/^\s*(\d+[.)]|[-*+])\s/.test(l) ? `${l}\n` : l)).join("\n"));
}

async function copySlack(path: string): Promise<void> {
  const r = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
  const j = r.ok ? await r.json() as { text: string } : { text: "" };
  await navigator.clipboard?.writeText(slackPart(j.text) || j.text);
}

/** Push to Notion; without Notion API access, copy the Notion shortcut command for Claude Code instead. */
// Notion push needs the private Notion wiring (backend/notion.py), not part of the public edition
const NOTION = false;

async function pushNotion(kind: Kind, date: string): Promise<string> {
  const r = await fetch("/api/meetings/notion", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, date }) });
  const j = await r.json().catch(() => null) as { projects?: string[]; detail?: unknown } | null;
  if (!r.ok && typeof j?.detail === "string" && j.detail.includes("not connected")) {
    const cmd = `Push Notion ${kind} ${date}`;
    await navigator.clipboard?.writeText(cmd).catch(() => undefined);
    return `Copied "${cmd}". Paste it into Claude Code; Claude writes the recap into Notion in your Chrome.`;
  }
  if (!r.ok) throw new Error(typeof j?.detail === "string" ? j.detail : `HTTP ${r.status}`);
  return `Pushed to Notion: ${(j?.projects ?? []).join(", ")}.`;
}

/** Full-width recap: formatted reading view; Edit shows the markdown with a live preview next to it. */
function RecapView({ kind, s, onClose, onChanged, onMsg }: { kind: Kind; s: Session; onClose: () => void;
  onChanged: () => void; onMsg: (m: string) => void }) {
  const path = s.files.recap!;
  const f = useJson<{ text: string }>(`/api/file?path=${encodeURIComponent(path)}`);
  const [base, setBase] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (f.data && base === null) { setBase(f.data.text); setText(f.data.text); } }, [f.data, base]);
  if (f.error) return <p className="error">{f.error}</p>;
  if (base === null) return <p className="muted">Loading…</p>;
  const draft = base.trimStart().startsWith("<!-- status: draft");
  const dirty = text !== base;
  const save = async () => {
    setBusy(true);
    const r = await fetch("/api/meetings/notes", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, date: s.date, text, expect: base, which: "recap" }) });
    const j = await r.json().catch(() => null) as { tasks_added?: number; detail?: unknown } | null;
    setBusy(false);
    if (!r.ok) { onMsg(typeof j?.detail === "string" ? j.detail : `Save failed (HTTP ${r.status})`); return; }
    const saved = text.replace(/^\s*<!-- status: draft[^\n]*-->\n?/, "");
    setBase(saved); setText(saved); setEditing(false);
    onMsg(`Recap for ${s.date} saved — marked reviewed.${j?.tasks_added ? ` ${j.tasks_added} todo(s) added to research_tasks.md (Action items).` : ""}`);
    onChanged();
  };
  return (
    <section className="card recap-view">
      <div className="card-head">
        <h2>{kind === "advisor" ? "Advisor" : "Group"} meeting · {s.date}</h2>
        <span className={`status s-${draft ? "stale" : "ok"}`}>{draft ? "draft" : "reviewed"}</span>
        <span className="recap-actions">
          {editing
            ? <><button onClick={() => void save()} disabled={busy || (!dirty && !draft)}>{draft && !dirty ? "Mark reviewed" : "Save"}</button>
                <button className="linkish" onClick={() => { setText(base); setEditing(false); }}>Cancel</button></>
            : <>{draft && <button onClick={() => { setText(base); void save(); }} disabled={busy} title="Looks right as is">Mark reviewed</button>}
                <button onClick={() => setEditing(true)}>Edit</button></>}
          <button className="ask" onClick={() => void copySlack(path).then(() => onMsg("Slack recap copied."))}>Copy for Slack</button>
          {NOTION && !draft && !editing && <button onClick={() => pushNotion(kind, s.date).then(onMsg, (e) => onMsg(`Notion push failed: ${e instanceof Error ? e.message : String(e)}`)).then(onChanged)}>Push to Notion</button>}
          <button className="linkish" onClick={onClose}>Close</button>
        </span>
      </div>
      {draft && <p className="banner small">Drafted by Claude from the Zoom notes. Check it, especially the open questions at the end, then Edit or Mark reviewed.</p>}
      <div className={editing ? "recap-split" : ""}>
        {editing && <textarea className="recap-edit" value={text} aria-label="Recap (markdown)" onChange={(e) => setText(e.target.value)} />}
        <div className="recap-preview">{(() => {
          const md = editing ? text : base;
          const slack = slackPart(md);
          const rest = prettyRecap(md).replace(/^## Slack \/ Notion recap\s*\n[\s\S]*?(?=^## |(?![\s\S]))/m, "")
            .replace(/^# [^\n]*\n/, "");
          return (<>
            <div className="recap-send">
              <div className="recap-send-head"><b>📨 Goes to Slack &amp; Notion</b>
                <span className="muted small">exactly what Copy for Slack copies{NOTION ? " and Push to Notion posts" : ""}</span>
                <button className="ask small" onClick={() => void navigator.clipboard?.writeText(slack).then(() => onMsg("Slack recap copied."))}>Copy</button>
              </div>
              {slack ? <Markdown text={prettyRecap(`## Slack / Notion recap\n${slack}\n`).replace(/^## Slack \/ Notion recap\s*\n/, "")} base={path} />
                : <p className="muted small">No "## Slack / Notion recap" section in this recap.</p>}
            </div>
            <div className="recap-rest">
              <div className="muted small recap-rest-head">Only on the platform (not sent)</div>
              <Markdown text={rest} base={path} />
            </div>
          </>);
        })()}</div>
      </div>
    </section>
  );
}

function RecapBar({ s, kind, onEdit, editing, onOpen, onPushed, onError }: { s: Session; kind: Kind; onEdit: () => void; editing: boolean;
  onOpen: (p: string) => void; onPushed: (m: string) => void; onError: (m: string) => void }) {
  const [copied, setCopied] = useState(false);
  const [pushing, setPushing] = useState(false);
  const push = async () => {
    setPushing(true);
    try { onPushed(await pushNotion(kind, s.date)); }
    catch (e) { onError(`Notion push failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setPushing(false); }
  };
  const n = s.notion;
  if (!s.files.recap && !s.files.zoom) return null;
  const copy = async () => { await copySlack(s.files.recap!); setCopied(true); };
  return (
    <div className={`recap-bar${s.recap === "draft" ? " draft" : ""}`}>
      {s.files.recap
        ? <span className="small"><b>Recap</b> · {s.recap === "draft" ? "draft from the Zoom notes — review and save" : "reviewed"}</span>
        : <span className="small muted">Zoom notes saved; recap not drafted yet</span>}
      {s.files.recap && <button onClick={onEdit}>{editing ? "Close recap" : s.recap === "draft" ? "Review recap" : "Open recap"}</button>}
      {s.files.recap && <button className="ask small" onClick={() => void copy()}>{copied ? "Copied" : "Copy for Slack"}</button>}
      {NOTION && s.recap === "reviewed" && <button onClick={() => void push()} disabled={pushing}
        title="Puts this recap on the project Notion pages (Meeting notes). Without Notion API access it copies a command for Claude Code instead.">{pushing ? "Pushing…" : n?.pushed_at ? "Push again" : "Push to Notion"}</button>}
      {NOTION && n?.pushed_at && <span className={`small ${n.changed ? "error" : "muted"}`}>
        {n.changed ? "edited since the last push" : `in Notion (${n.projects.join(", ")}) · ${ago(n.pushed_at)}`}</span>}
      {s.files.zoom && <button className="linkish small" onClick={() => onOpen(s.files.zoom!)}>Zoom notes</button>}
    </div>
  );
}

function NotesEditor({ kind, day, path, which = "notes", onSaved, onError }: { kind: Kind; day: string; path?: string; which?: Which; onSaved: () => void; onError: (m: string) => void }) {
  const [base, setBase] = useState<string | null>(path ? null : "");
  const [text, setText] = useState("");
  useEffect(() => {
    if (!path) { setBase(""); setText(""); return; }
    fetch(`/api/file?path=${encodeURIComponent(path)}`).then((r) => (r.ok ? r.json() : { text: "" }))
      .then((j: { text: string }) => { setBase(j.text); setText(j.text); }, () => setBase(""));
  }, [path]);
  if (base === null) return <p className="muted small">Loading…</p>;
  const save = async () => {
    const err = await postJson("/api/meetings/notes", { kind, date: day, text, expect: base, which });
    if (err) onError(err); else { setBase(text); onSaved(); }
  };
  return (
    <div className="reply">
      <textarea rows={16} value={text} onChange={(e) => setText(e.target.value)} aria-label={`${kind} ${which}`}
        placeholder={which === "notes" ? "Paste the Zoom summary or write your notes (markdown)…" : `Write the ${which} (markdown)…`} />
      <button onClick={save} disabled={!text.trim() || text === base}>Save {which}</button>
    </div>
  );
}

export function Meetings({ onPrompt, onReply }: PanelProps) {
  const [layout, setLayout] = useState(0);
  const m = useJson<MeetingsView>("/api/meetings");
  const [open, setOpen] = useState<string | null>(null);
  const [recap, setRecap] = useState<{ kind: Kind; date: string } | null>(null);
  const [notes, setNotesRaw] = useState<{ kind: Kind; which: Which } | null>(null);
  const toggle = (kind: Kind, which: Which) => setNotesRaw((n) => (n?.kind === kind && n.which === which ? null : { kind, which }));
  const isOpen = (kind: Kind, which: Which) => notes?.kind === kind && notes.which === which;
  const [histEdit, setHistEdit] = useState<{ kind: Kind; date: string; which: Which } | null>(null);
  const [q, setQ] = useState("");
  const [qKind, setQKind] = useState<Kind>("advisor");
  const [msg, setMsg] = useState<string | null>(null);
  const d = m.data;
  const addQ = async () => {
    const err = await postJson("/api/meetings/question", { kind: qKind, text: q });
    if (err) setMsg(err); else setQ("");
    m.reload();
  };
  const file = (label: string, path?: string) => path && <button key={label} className="linkish" onClick={() => setOpen(path)}>{label}</button>;

  return (
    <div className="meetings">
      <Toolbar reload={m.reload} onPrompt={onPrompt}>
        <button className="linkish small" title="Put the cards back in their default order" onClick={() => { resetCardOrder(LAYOUT_KEY); setLayout((n) => n + 1); }}>Reset layout</button>
      </Toolbar>
      <Notice msg={msg} onClear={() => setMsg(null)} />
      {m.error && <p className="error">{m.error}</p>}
      {open && <FileView path={open} onClose={() => setOpen(null)} />}
      {d && !open && recap && (() => {
        const all = [d.kinds[recap.kind].current, ...d.kinds[recap.kind].history];
        const sess = all.find((x) => x.date === recap.date && x.files.recap);
        return sess ? <RecapView kind={recap.kind} s={sess} onClose={() => setRecap(null)} onChanged={m.reload} onMsg={setMsg} /> : null;
      })()}
      {d && !open && !recap && (
        <>
          {(() => {
            const cards: { id: string; wide?: boolean; label: string; node: ReactNode }[] = [];
            for (const k of ["group", "advisor"] as Kind[]) {
              const v = d.kinds[k];
              const c = v.current;
              cards.push({ id: `meet-${k}`, label: v.title, node: (
                <section className="card meeting">
                  <div className="card-head"><h2>{v.title}</h2><span className={`status s-${c.status === "planned" ? "stale" : "ok"}`}>{STATUS[c.status]}</span></div>
                  <p className="small"><b>{fmt(v.next)}</b> <span className="muted">· {until(v.next, d.now)}{k === "advisor" ? " · 1 hour, may be cancelled" : " · 2 slides + speaking notes"}</span></p>
                  <div className="small files-row">{file("Slides", c.files.slides)}{file("Notes", c.files.notes)}
                    {v.last && <span className="muted"> · last: {v.last}</span>}</div>
                  <div className="toolbar">
                    <button className="quick" onClick={() => onPrompt(k === "advisor" ? PROMPTS.advisor(v.next_date, v.last) : PROMPTS.group(v.next_date))}>
                      {c.files.slides ? "Update slides" : "Prepare slides"}</button>
                    {k === "advisor" && <button className="quick" onClick={() => onPrompt(PROMPTS.slack(v.next_date))}>Cancelled → Slack update</button>}
                    <button onClick={() => toggle(k, "notes")}>{isOpen(k, "notes") ? "Close notes" : "Notes"}</button>
                    {c.files.slides && <button onClick={() => toggle(k, "slides")}>{isOpen(k, "slides") ? "Close slides" : "Edit slides"}</button>}
                    {c.files.slack && <button onClick={() => toggle(k, "slack")}>{isOpen(k, "slack") ? "Close Slack" : "Edit Slack"}</button>}
                    {(c.files.notes || c.recap === "reviewed") && <button className="quick" onClick={() => onPrompt(PROMPTS.notes(k, v.next_date))}>Process notes → tasks</button>}
                  </div>
                  {(() => {
                    const last = [c, ...v.history].find((x) => (x.files.recap || x.files.zoom) && (d.now - new Date(`${x.date}T12:00:00`).getTime()) < 10 * 86_400_000);
                    if (!last) return null;
                    return (
                      <div className="recap-wrap">
                        <div className="muted small">Last meeting · {last.date}</div>
                        <RecapBar s={last} kind={k} editing={false} onOpen={setOpen} onError={setMsg}
                          onPushed={(t) => { setMsg(t); m.reload(); }}
                          onEdit={() => setRecap({ kind: k, date: last.date })} />
                      </div>
                    );
                  })()}
                  {c.files.slack && <SlackMessage path={c.files.slack} />}
                  {notes?.kind === k && <NotesEditor key={notes.which} kind={k} day={v.next_date} which={notes.which} path={c.files[notes.which]}
                    onError={setMsg} onSaved={() => { setMsg(`Saved ${notes.which}.`); m.reload(); }} />}
                </section>) });
            }
            const qItem = (x: Question) => (
              <Replyable key={`${x.line}-${x.raw}`} label={`Meeting question (${x.kind})`} onReply={onReply}
                context={`Meeting question for the ${x.kind === "advisor" ? "advisor (the advisor)" : "group"} meeting, from ${d.questions_path} line ${x.line}:\n${x.raw}`}>
                <CheckItem path={d.questions_path} item={x} onDone={m.reload} onError={setMsg} deferTextClick={!!onReply} />
              </Replyable>);
            cards.push({ id: "questions", wide: true, label: "Questions to bring up", node: (
              <section className="card">
                <div className="card-head"><h2>Questions to bring up</h2></div>
                <div className="reply">
                  <select value={qKind} onChange={(e) => setQKind(e.target.value as Kind)} aria-label="Meeting">
                    <option value="advisor">Advisor</option><option value="group">Group</option></select>
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="A question or decision you need…" aria-label="New question"
                    onKeyDown={(e) => { if (e.key === "Enter" && q.trim()) void addQ(); }} style={{ flex: 1 }} />
                  <button onClick={addQ} disabled={!q.trim()}>Add</button>
                </div>
                {(["advisor", "group"] as Kind[]).map((k) => {
                  const qs = d.questions.filter((x) => x.kind === k);
                  const openQs = qs.filter((x) => !x.checked);
                  return (
                    <div key={k}>
                      <h3>{k === "advisor" ? "For the advisor" : "For the group"} <span className="muted small">{openQs.length} open</span></h3>
                      {openQs.length === 0 && <p className="muted small">None.</p>}
                      {openQs.map(qItem)}
                      {qs.length > openQs.length && <details className="small"><summary>{qs.length - openQs.length} discussed</summary>
                        {qs.filter((x) => x.checked).map(qItem)}</details>}
                    </div>
                  );
                })}
              </section>) });
            const isDone = (g: ActionGroup) => g.items.length > 0 && g.items.every((i) => i.checked);
            const renderItems = (g: ActionGroup) => g.items.map((i) => (
                <Replyable key={`${i.line}-${i.raw}`} label={`Action item ${i.id}`} onReply={onReply}
                  context={`Meeting action item from the ${g.date} meeting (research_tasks.md line ${i.line}):\n${i.raw}`}>
                  <CheckItem path={i.path ?? "research_tasks.md"} item={i} onDone={m.reload} onError={setMsg} deferTextClick={!!onReply}>
                    {i.id && <span className="muted small">{i.id} </span>}<Inline text={i.text} base={i.path ?? "research_tasks.md"} />
                  </CheckItem>
                </Replyable>));
            cards.push({ id: "actions", label: "Action items", node: (
              <ActionItems groups={d.action_items.filter((g) => !isDone(g))} render={renderItems} />) });
            if (d.action_items.some(isDone)) cards.push({ id: "actions-history", label: "Action items history", node: (
              <ActionItems groups={d.action_items.filter(isDone)} render={renderItems} title="Action items · history" history />) });
            for (const k of ["advisor", "group"] as Kind[]) {
              cards.push({ id: `history-${k}`, label: `History ${d.kinds[k].title}`, node: (
                <section className="card">
                  <div className="card-head"><h2>History · {d.kinds[k].title}</h2></div>
                  {d.kinds[k].history.length === 0 && <p className="muted small">Nothing yet.</p>}
                  <ul className="filelist">
                    {d.kinds[k].history.map((s) => (
                      <li key={s.date}>{s.date} <span className="muted small">· {STATUS[s.status]}{s.legacy ? " · older notes" : ""}</span>{" "}
                        {s.recap && <span className={`status s-${s.recap === "draft" ? "stale" : "ok"}`}>recap {s.recap}</span>}{" "}
                        {file("slides", s.files.slides)} {file("Slack", s.files.slack)} {file("notes", s.files.notes)} {file("Zoom", s.files.zoom)}{" "}
                        {s.files.recap && <><button className="link-btn small" onClick={() => setRecap({ kind: k, date: s.date })}>open recap</button> · </>}
                        {(["notes", "slides", "slack"] as Which[]).filter((w) => w === "notes" || s.files[w]).map((w) => {
                          const on = histEdit?.kind === k && histEdit.date === s.date && histEdit.which === w;
                          return <button key={w} className="link-btn small" onClick={() => setHistEdit(on ? null : { kind: k, date: s.date, which: w })}>
                            {on ? "close" : w === "notes" && !s.files.notes ? "+ notes" : `edit ${w}`}</button>;
                        }).reduce<ReactNode[]>((a, b) => (a.length ? [...a, " · ", b] : [b]), [])}
                        {histEdit?.kind === k && histEdit.date === s.date &&
                          <NotesEditor key={`${k}-${s.date}-${histEdit.which}`} kind={k} day={s.date} which={histEdit.which} path={s.files[histEdit.which]}
                            onError={setMsg} onSaved={() => { setMsg(`Saved ${histEdit.which} for ${s.date}.`); m.reload(); }} />}</li>
                    ))}
                  </ul>
                </section>) });
            }
            return <SortableCards key={layout} storageKey={LAYOUT_KEY} items={cards} />;
          })()}
        </>
      )}
    </div>
  );
}
