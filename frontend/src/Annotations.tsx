import { useState } from "react";
import { FileView, Markdown, Notice, Toolbar, postJson, useJson, when } from "./common";
import type { PanelProps } from "./common";

interface Block { id: string; path: string; line: number; end_line: number; end_raw: string; meta: string;
  heading: string; text: string; replied: boolean; mtime: number }
interface Data { blocks: Block[]; pending: number }

const APPLY = "Find the ⚠️ question blocks I have answered ('→ ' lines), apply each answer, then remove the block";
const ACTIONS: [string, string][] = [["Process my replies", APPLY]];

function Reply({ b, onSaved, onError }: { b: Block; onSaved: () => void; onError: (m: string) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const err = await postJson("/api/edit/annotation-reply", { path: b.path, line: b.line, end_line: b.end_line, end_raw: b.end_raw, text });
    setBusy(false);
    if (err) onError(err); else setText("");
    onSaved();
  };
  return (
    <div className="reply">
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3}
        placeholder="Your answer — saved into the file as “→ the user: …”; then press “Apply my answers” so Claude applies it" />
      <button onClick={save} disabled={busy || !text.trim()}>Save reply</button>
    </div>
  );
}

export function Annotations({ onAsk, onPrompt }: PanelProps) {
  const { data, error, reload } = useJson<Data>("/api/annotations");
  const [msg, setMsg] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="annotations">
      <Toolbar reload={reload} actions={ACTIONS} onPrompt={onPrompt}>
        {data && <span className="muted small">{data.pending} waiting for you · {data.blocks.length - data.pending} answered, waiting for Claude</span>}
      </Toolbar>
      <Notice msg={msg} onClear={() => setMsg(null)} />
      {error && <p className="error">{error}</p>}
      {open && <FileView path={open} onClose={() => setOpen(null)} />}
      {data && data.blocks.length === 0 && <p className="muted">No open questions. 🎉</p>}
      {data && !open && (
        <div className="cards one">
          {data.blocks.map((b) => (
            <article key={b.id} className={`card annot ${b.replied ? "replied" : ""}`}>
              <div className="card-head">
                <span className={`status ${b.replied ? "s-ok" : "s-stale"}`}>{b.replied ? "Answered" : "Waiting"}</span>
                <button className="linkish small" onClick={() => setOpen(b.path)}>{b.path}:{b.line}</button>
                <button className="ask" onClick={() => onAsk(`${b.path}:${b.line}`, b.text)}>Ask agent</button>
              </div>
              <div className="small muted">{b.heading && `§ ${b.heading} · `}{b.meta} · file changed {when(b.mtime)}</div>
              <Markdown text={b.text} base={b.path} />
              <Reply b={b} onSaved={reload} onError={setMsg} />
            </article>
          ))}
        </div>
      )}
    </div>
  );
}


/** One question: heading + text; double-click it to open the reply box underneath. */
function QuestionItem({ b, onOpen, onAsk, onSaved, onError }: { b: Block; onOpen: (path: string) => void;
  onAsk: PanelProps["onAsk"]; onSaved: () => void; onError: (m: string) => void }) {
  const [replying, setReplying] = useState(false);
  return (
    <article className="annot-q" title={replying ? undefined : "Double-click to answer"}
      onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest("textarea, button, a")) { window.getSelection?.()?.removeAllRanges(); setReplying(true); } }}>
      <div className="small muted">
        {b.heading ? <b>{b.heading}</b> : null}{b.heading ? " · " : ""}
        <button className="linkish small" onClick={() => onOpen(b.path)}>{b.path.split("/").pop()}</button>
        {" · "}<button className="linkish small" onClick={() => onAsk(`${b.path}:${b.line}`, b.text)}>Ask agent</button>
      </div>
      <Markdown text={b.text} base={b.path} />
      {replying && <Reply b={b} onSaved={() => { setReplying(false); onSaved(); }} onError={onError} />}
    </article>
  );
}

/** Today's "Questions for you": the ⚠️ Question for you blocks waiting for an answer (Annotations folded into Today).
 *  Renders nothing when there are none. */
export function QuestionsCard({ onAsk, onPrompt, onError }: { onAsk: PanelProps["onAsk"]; onPrompt: PanelProps["onPrompt"];
  onError: (m: string) => void }) {
  const { data, reload } = useJson<Data>("/api/annotations");
  const [open, setOpen] = useState<string | null>(null);
  if (!data || !Array.isArray(data.blocks) || data.blocks.length === 0) return null;
  const waiting = data.blocks.filter((b) => !b.replied);
  const answered = data.blocks.length - waiting.length;
  return (
    <section className="card questions">
      <div className="card-head"><h2>Questions for you</h2>
        <span className="muted small">{waiting.length} waiting{answered ? ` · ${answered} answered, waiting for Claude` : ""}</span>
        {answered > 0 && <button className="ask" onClick={() => onPrompt(APPLY)}>Apply my answers</button>}
      </div>
      <p className="muted small">Double-click a question to answer it; the answer is saved under the question in that file.</p>
      {open && <FileView path={open} onClose={() => setOpen(null)} />}
      <div className="scroll-list">
        {waiting.map((b) => <QuestionItem key={b.id} b={b} onOpen={(p) => setOpen(open === p ? null : p)} onAsk={onAsk}
          onSaved={reload} onError={onError} />)}
      </div>
    </section>
  );
}
