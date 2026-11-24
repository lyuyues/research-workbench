export type AgentEvent =
  | { kind: "started" }
  | { kind: "session"; session_id: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; summary: string }
  | { kind: "done"; session_id: string | null; is_error: boolean }
  | { kind: "error"; message: string }
  | { kind: "changes"; commit: string | null; files: string[] };

export type ChatItem =
  | { role: "user" | "assistant" | "tool" | "error"; text: string }
  | { role: "changes"; commit: string; files: string[]; undone: boolean; undoing: boolean };

/**
 * idle: nothing in flight. starting: prompt sent, no `started` yet — an error here is a
 * no-run error (busy / bad message / journal initializing) and ends the attempt.
 * running: the server confirmed a run; only its terminal `changes` ends it.
 */
export type Phase = "idle" | "starting" | "running";

export interface ChatState {
  items: ChatItem[];
  sessionId: string | null;
  phase: Phase;
  /** running and `done`/`error` already seen: waiting for the journal snapshot */
  finishing: boolean;
  /** the socket dropped mid-run; the server keeps running it */
  orphaned: boolean;
  /** a `session` event arrived during the current run */
  sawSession: boolean;
  /** text of the prompt awaiting `started` */
  pendingText: string | null;
  /** text the UI should put back into the draft after a no-run error */
  restoreDraft: string | null;
}

export type Action =
  | { type: "send"; text: string }
  | { type: "event"; event: AgentEvent }
  | { type: "notice"; text: string }
  | { type: "undoing"; commit: string; on: boolean }
  | { type: "undone"; commit: string }
  | { type: "disconnected" }
  | { type: "orphanCancelled" }
  | { type: "draftRestored" }
  | { type: "reset" };

export const initialState: ChatState = {
  items: [], sessionId: null, phase: "idle", finishing: false, orphaned: false,
  sawSession: false, pendingText: null, restoreDraft: null,
};

export const DISCONNECTED_MESSAGE =
  "Disconnected. The task keeps running on the server; its result will be visible once reconnect lands in Phase 2. Click “Stop background task” to abort it.";
export const SESSION_RESET_MESSAGE = "Session was reset — you can retry now";

const addItem = (state: ChatState, item: ChatItem): ChatState => ({ ...state, items: [...state.items, item] });

const mapChanges = (state: ChatState, commit: string, patch: Partial<{ undone: boolean; undoing: boolean }>) => {
  if (!state.items.some((it) => it.role === "changes" && it.commit === commit)) return state;
  return {
    ...state,
    items: state.items.map((it) => (it.role === "changes" && it.commit === commit ? { ...it, ...patch } : it)),
  };
};

function onError(state: ChatState, message: string): ChatState {
  let next = addItem(state, { role: "error", text: message });
  if (state.phase === "starting") {
    return { ...next, phase: "idle", restoreDraft: state.pendingText, pendingText: null };
  }
  if (state.phase === "running") {
    next = { ...next, finishing: true };
    // A run that fails before claude even reports its session most likely failed to
    // `--resume` a stale id; drop it so the next prompt starts fresh. Not for cancels.
    if (!state.sawSession && state.sessionId && message !== "cancelled") {
      next = addItem({ ...next, sessionId: null }, { role: "error", text: SESSION_RESET_MESSAGE });
    }
  }
  return next;
}

function onEvent(state: ChatState, e: AgentEvent): ChatState {
  switch (e.kind) {
    case "started":
      return state.phase === "starting" ? { ...state, phase: "running", pendingText: null } : state;
    case "session": return { ...state, sessionId: e.session_id, sawSession: true };
    case "text": return addItem(state, { role: "assistant", text: e.text });
    case "tool": return addItem(state, { role: "tool", text: `${e.name} ${e.summary}`.trim() });
    case "error": return onError(state, e.message);
    case "done":
      return {
        ...state, sessionId: e.session_id ?? state.sessionId,
        finishing: state.phase === "running" ? true : state.finishing,
      };
    case "changes": {
      const next = e.commit
        ? addItem(state, { role: "changes", commit: e.commit, files: e.files, undone: false, undoing: false })
        : state;
      if (next.phase === "idle" && !next.orphaned && !next.finishing) return next;
      return { ...next, phase: "idle", finishing: false, orphaned: false, pendingText: null };
    }
    default: return state; // unknown server event kinds are ignored
  }
}

export function reducer(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case "send":
      return {
        ...addItem(state, { role: "user", text: action.text }),
        phase: "starting", finishing: false, sawSession: false, pendingText: action.text, restoreDraft: null,
      };
    case "event":
      return onEvent(state, action.event);
    case "notice":
      return addItem(state, { role: "error", text: action.text });
    case "undoing":
      return mapChanges(state, action.commit, { undoing: action.on });
    case "undone":
      return mapChanges(state, action.commit, { undone: true, undoing: false });
    case "disconnected":
      if (state.phase === "idle") return state;
      return {
        ...addItem(state, { role: "error", text: DISCONNECTED_MESSAGE }),
        phase: "idle", finishing: false, orphaned: true, pendingText: null,
      };
    case "orphanCancelled":
      return { ...state, orphaned: false };
    case "draftRestored":
      return { ...state, restoreDraft: null };
    case "reset":
      return initialState;
  }
}
