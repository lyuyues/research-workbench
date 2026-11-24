import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { initialState, reducer } from "./agentReducer";
import type { AgentEvent } from "./agentReducer";

const wsUrl = () => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/agent`;

export interface Attachment { label: string; text: string }

const MAX_IMAGES = 4;
const MAX_SIDE = 2000;

/** Read a pasted/dropped image as a data URL, downscaling big ones to JPEG so a message stays small. */
export async function imageToDataUrl(file: Blob): Promise<string> {
  const url = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
  if (file.size < 1_500_000 || typeof createImageBitmap !== "function") return url;
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext("2d")?.drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.88);
  } catch {
    return url;
  }
}

interface Props {
  panel: string;
  /** a panel card attached by "Ask agent"; sent once as context.card, then cleared */
  attachment?: Attachment | null;
  onDetach?: () => void;
  /** mobile drawer: renders a Hide button in the header (hidden on desktop by CSS) */
  onClose?: () => void;
  connectTimeoutMs?: number;
  /** a quick-action prompt to put in the input box (the user still presses Send);
   *  with send: true it is sent right away (e.g. an inline reply under a note, which already carries its context) */
  preset?: { text: string; n: number; send?: boolean } | null;
}

export function AgentChat({ panel, attachment = null, onDetach, onClose, connectTimeoutMs = 10_000, preset = null }: Props) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const sendRef = useRef<(t?: string) => void>(() => {});
  useEffect(() => {
    if (!preset) return;
    if (preset.send) sendRef.current(preset.text); else setDraft(preset.text);
  }, [preset]);
  const ws = useRef<WebSocket | null>(null);
  const connecting = useRef<Promise<WebSocket> | null>(null);
  const log = useRef<HTMLDivElement>(null);
  // Synchronous guard against double POSTs (the `undoing` flag only lands after a re-render).
  const undoInFlight = useRef(new Set<string>());
  const idle = state.phase === "idle";

  // Scroll only the log container, never the page (scrollIntoView moves the whole layout on iOS).
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [state.items, state.phase, state.finishing]);

  useEffect(() => () => ws.current?.close(), []);

  useEffect(() => {
    if (state.restoreDraft === null) return;
    const text = state.restoreDraft;
    setDraft((d) => d || text);
    dispatch({ type: "draftRestored" });
  }, [state.restoreDraft]);

  // One socket at a time. The pending socket is stored immediately and its promise is
  // shared, so send/stop/orphan-cancel issued while CONNECTING all reuse it.
  const connect = useCallback((): Promise<WebSocket> => {
    const cur = ws.current;
    if (cur && cur.readyState === WebSocket.OPEN) return Promise.resolve(cur);
    if (connecting.current) return connecting.current;
    const sock = new WebSocket(wsUrl());
    ws.current = sock;
    const promise = new Promise<WebSocket>((resolve, reject) => {
      let settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        connecting.current = null;
        // Forget the socket first so its close event is treated as stale (no `disconnected`):
        // the caller reports this failure itself.
        if (ws.current === sock) ws.current = null;
        reject(new Error(message));
      };
      const timer = setTimeout(() => { fail("Connection timed out"); sock.close(); }, connectTimeoutMs);
      sock.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        connecting.current = null;
        resolve(sock);
      };
      sock.onerror = () => fail("Connection failed");
      sock.onclose = () => {
        fail("Connection failed");
        if (ws.current !== sock) return; // a replaced/failed socket: ignore
        ws.current = null;
        dispatch({ type: "disconnected" }); // no-op unless a run was in flight
      };
      sock.onmessage = (m) => {
        let event: AgentEvent;
        try {
          event = JSON.parse(m.data) as AgentEvent;
        } catch {
          dispatch({ type: "notice", text: `Could not parse server message: ${String(m.data).slice(0, 200)}` });
          return;
        }
        dispatch({ type: "event", event });
      };
    });
    connecting.current = promise;
    return promise;
  }, [connectTimeoutMs]);

  const addImages = async (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) return false;
    const room = MAX_IMAGES - images.length;
    if (room <= 0) { dispatch({ type: "notice", text: `At most ${MAX_IMAGES} images per message` }); return true; }
    try {
      const urls = await Promise.all(imgs.slice(0, room).map(imageToDataUrl));
      setImages((cur) => [...cur, ...urls].slice(0, MAX_IMAGES));
    } catch (e) {
      dispatch({ type: "notice", text: `Could not read image: ${String(e)}` });
    }
    return true;
  };

  const send = async (override?: string) => {
    const typed = (override ?? draft).trim();
    const pics = override === undefined ? images : [];
    if (!typed && !pics.length) return;
    if (!idle) { setDraft(typed); return; } // agent busy: leave it in the box for the user to send
    const text = typed || "(see image)";
    if (override === undefined) { setDraft(""); setImages([]); }
    const card = attachment?.text;
    dispatch({ type: "send", text: pics.length ? `${text}  [${pics.length} image${pics.length > 1 ? "s" : ""}]` : text });
    onDetach?.();
    try {
      const sock = await connect();
      const msg: Record<string, unknown> = { prompt: text, context: card ? { panel, card } : { panel } };
      if (pics.length) msg.images = pics;
      if (state.sessionId) msg.session_id = state.sessionId; // backend rejects null-ish ids
      sock.send(JSON.stringify(msg));
    } catch (e) {
      // still in "starting", so this ends the attempt and restores the draft
      dispatch({ type: "event", event: { kind: "error", message: e instanceof Error ? e.message : String(e) } });
    }
  };

  sendRef.current = (t) => { void send(t); };

  const sendCancel = async (): Promise<boolean> => {
    try {
      (await connect()).send(JSON.stringify({ type: "cancel" }));
      return true;
    } catch (e) {
      dispatch({ type: "notice", text: `Stop failed: ${e instanceof Error ? e.message : String(e)}` });
      return false;
    }
  };

  // The run belongs to the app, not the socket, so a fresh socket can cancel it. Its
  // `cancelled`/`changes` go to the dead socket, hence the local notice.
  const cancelOrphan = async () => {
    if (await sendCancel()) {
      dispatch({ type: "orphanCancelled" });
      dispatch({ type: "notice", text: "Requested stop of background task" });
    }
  };

  const undo = async (commit: string) => {
    if (undoInFlight.current.has(commit)) return;
    undoInFlight.current.add(commit);
    dispatch({ type: "undoing", commit, on: true });
    try {
      const r = await fetch("/api/agent/undo", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ commit }),
      });
      if (r.ok) return dispatch({ type: "undone", commit });
      let detail: unknown = `HTTP ${r.status}`;
      try { detail = (await r.json()).detail ?? detail; } catch { /* non-JSON body, e.g. an Access page */ }
      dispatch({ type: "undoing", commit, on: false });
      dispatch({ type: "notice", text: `Undo failed: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` });
    } catch (e) {
      dispatch({ type: "undoing", commit, on: false });
      dispatch({ type: "notice", text: `Undo failed: ${String(e)}` });
    } finally {
      undoInFlight.current.delete(commit);
    }
  };

  return (
    <div className="chat">
      <div className="chat-head">
        <span>Agent</span>
        <div className="chat-head-actions">
          <button onClick={() => dispatch({ type: "reset" })} disabled={!idle}>New chat</button>
          {onClose && (
            <button className="mobile-only" onClick={onClose} aria-expanded="true" aria-controls="agent-drawer">
              Hide
            </button>
          )}
        </div>
      </div>
      <div className="chat-log" ref={log} role="log" aria-live="polite">
        {state.items.map((it, i) =>
          it.role === "changes" ? (
            <div key={i} className="msg changes">
              <div>Changed {it.files.length} file(s)</div>
              <ul>{it.files.map((f) => <li key={f}>{f}</li>)}</ul>
              {it.undone ? <em>Undone</em> : (
                <button
                  onClick={() => undo(it.commit)}
                  disabled={!idle || it.undoing}
                  aria-label={`Undo this change (${it.commit.slice(0, 7)})`}
                >
                  {it.undoing ? "Undoing…" : "Undo"}
                </button>
              )}
            </div>
          ) : (
            <div key={i} className={`msg ${it.role}`}>{it.text}</div>
          ))}
        {!idle && <div className="msg tool">{state.finishing ? "Saving changes…" : "Thinking…"}</div>}
        {idle && state.orphaned && (
          <button className="orphan" onClick={cancelOrphan}>Stop background task</button>
        )}
      </div>
      {attachment && (
        <div className="attachment">
          <span>Attached: {attachment.label}</span>
          <button onClick={onDetach} aria-label={`Remove ${attachment.label}`}>×</button>
        </div>
      )}
      {images.length > 0 && (
        <div className="chat-images">
          {images.map((src, i) => (
            <div key={i} className="chat-thumb">
              <img src={src} alt={`Pasted image ${i + 1}`} />
              <button onClick={() => setImages((cur) => cur.filter((_, j) => j !== i))}
                aria-label={`Remove image ${i + 1}`}>×</button>
            </div>
          ))}
        </div>
      )}
      <div
        className={`chat-input${dragOver ? " drag" : ""}`}
        onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragOver(true); } }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          setDragOver(false);
          const files = Array.from(e.dataTransfer.files);
          if (files.some((f) => f.type.startsWith("image/"))) { e.preventDefault(); void addImages(files); }
        }}
      >
        <textarea
          value={draft}
          aria-label="Message to the agent"
          placeholder={`Ask the agent (panel: ${panel}) — paste or drop images`}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.items)
              .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
              .map((it) => it.getAsFile())
              .filter((f): f is File => f !== null);
            if (files.length) { e.preventDefault(); void addImages(files); }
          }}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(); }}
        />
        {idle
          ? <button onClick={() => void send()} disabled={!draft.trim() && !images.length}>Send</button>
          : <button className="stop" onClick={sendCancel}>Stop</button>}
      </div>
    </div>
  );
}
