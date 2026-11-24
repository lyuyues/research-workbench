import { describe, expect, it } from "vitest";
import { DISCONNECTED_MESSAGE, SESSION_RESET_MESSAGE, initialState, reducer } from "./agentReducer";
import type { Action, ChatState } from "./agentReducer";

const run = (s: ChatState, ...actions: Action[]) => actions.reduce(reducer, s);
const ev = (event: Extract<Action, { type: "event" }>["event"]): Action => ({ type: "event", event });
const started = (text = "x") => run(initialState, { type: "send", text }, ev({ kind: "started" }));

describe("agent reducer", () => {
  it("send adds user item and enters starting", () => {
    const s = reducer(initialState, { type: "send", text: "hi" });
    expect(s.items).toEqual([{ role: "user", text: "hi" }]);
    expect(s.phase).toBe("starting");
  });
  it("started moves starting -> running", () => {
    expect(started().phase).toBe("running");
  });
  it("tracks session, text, tool, changes", () => {
    const s = run(started(),
      ev({ kind: "session", session_id: "s1" }),
      ev({ kind: "tool", name: "Edit", summary: "a.md" }),
      ev({ kind: "text", text: "done!" }),
      ev({ kind: "done", session_id: "s1", is_error: false }),
      ev({ kind: "changes", commit: "abc", files: ["a.md"] }));
    expect(s.sessionId).toBe("s1");
    expect(s.phase).toBe("idle");
    expect(s.items.slice(1)).toEqual([
      { role: "tool", text: "Edit a.md" },
      { role: "assistant", text: "done!" },
      { role: "changes", commit: "abc", files: ["a.md"], undone: false, undoing: false },
    ]);
  });
  it("done keeps blocking until changes, and shows the finishing state", () => {
    let s = run(started(), ev({ kind: "done", session_id: "s2", is_error: false }));
    expect(s.phase).toBe("running");
    expect(s.finishing).toBe(true);
    expect(s.sessionId).toBe("s2");
    s = reducer(s, ev({ kind: "changes", commit: null, files: [] }));
    expect(s.phase).toBe("idle");
    expect(s.finishing).toBe(false);
  });
  it("changes without commit adds nothing", () => {
    const s = reducer(initialState, ev({ kind: "changes", commit: null, files: [] }));
    expect(s.items).toEqual([]);
  });
  it("error while starting is a no-run error: back to idle and the text is restored", () => {
    const s = run(initialState, { type: "send", text: "hello" }, ev({ kind: "error", message: "Another agent task is already running" }));
    expect(s.phase).toBe("idle");
    expect(s.restoreDraft).toBe("hello");
    expect(s.items[1]).toEqual({ role: "error", text: "Another agent task is already running" });
    expect(reducer(s, { type: "draftRestored" }).restoreDraft).toBeNull();
  });
  it("error while running keeps running until changes (cancel flow)", () => {
    let s = run(started(), ev({ kind: "session", session_id: "s1" }), ev({ kind: "error", message: "cancelled" }));
    expect(s.phase).toBe("running");
    expect(s.finishing).toBe(true);
    expect(s.restoreDraft).toBeNull();
    s = reducer(s, ev({ kind: "changes", commit: "abc", files: ["a.md"] }));
    expect(s.phase).toBe("idle");
    expect(s.items[s.items.length - 1]).toMatchObject({ role: "changes", commit: "abc" });
  });
  it("error before any session event resets a stale session id", () => {
    const base = { ...initialState, sessionId: "old" };
    const s = run(base, { type: "send", text: "x" }, ev({ kind: "started" }),
      ev({ kind: "error", message: "claude exited 1: no conversation found" }));
    expect(s.sessionId).toBeNull();
    expect(s.items[s.items.length - 1]).toEqual({ role: "error", text: SESSION_RESET_MESSAGE });
  });
  it("error after the session event keeps the session id", () => {
    const base = { ...initialState, sessionId: "old" };
    const s = run(base, { type: "send", text: "x" }, ev({ kind: "started" }),
      ev({ kind: "session", session_id: "old" }), ev({ kind: "error", message: "boom" }));
    expect(s.sessionId).toBe("old");
  });
  it("a cancel before the session event does not reset the session", () => {
    const base = { ...initialState, sessionId: "old" };
    const s = run(base, { type: "send", text: "x" }, ev({ kind: "started" }), ev({ kind: "error", message: "cancelled" }));
    expect(s.sessionId).toBe("old");
  });
  it("notice adds an error item without touching phase", () => {
    const s = reducer(started(), { type: "notice", text: "Undo failed" });
    expect(s.phase).toBe("running");
    expect(s.items[s.items.length - 1]).toEqual({ role: "error", text: "Undo failed" });
  });
  it("undoing / undone mark the changes item", () => {
    let s = reducer(initialState, ev({ kind: "changes", commit: "abc", files: ["a.md"] }));
    s = reducer(s, { type: "undoing", commit: "abc", on: true });
    expect(s.items[0]).toMatchObject({ undoing: true, undone: false });
    s = reducer(s, { type: "undone", commit: "abc" });
    expect(s.items[0]).toMatchObject({ undoing: false, undone: true });
  });
  it("undone for an unknown commit is a no-op", () => {
    const s = reducer(initialState, ev({ kind: "changes", commit: "abc", files: ["a.md"] }));
    expect(reducer(s, { type: "undone", commit: "zzz" }).items).toEqual(s.items);
  });
  it("reset clears everything", () => {
    const s = reducer({ ...initialState, sessionId: "s1", orphaned: true }, { type: "reset" });
    expect(s).toEqual(initialState);
  });
  it("disconnected while running orphans the run", () => {
    const s = reducer(started(), { type: "disconnected" });
    expect(s.phase).toBe("idle");
    expect(s.orphaned).toBe(true);
    expect(s.items[s.items.length - 1]).toEqual({ role: "error", text: DISCONNECTED_MESSAGE });
    expect(DISCONNECTED_MESSAGE).toContain("Stop background task");
  });
  it("disconnected while idle is a no-op", () => {
    expect(reducer(initialState, { type: "disconnected" })).toBe(initialState);
  });
  it("changes and orphanCancelled clear orphaned", () => {
    const o = reducer(started(), { type: "disconnected" });
    expect(reducer(o, ev({ kind: "changes", commit: null, files: [] })).orphaned).toBe(false);
    expect(reducer(o, { type: "orphanCancelled" }).orphaned).toBe(false);
  });
  it("started outside of starting is ignored", () => {
    expect(reducer(initialState, ev({ kind: "started" }))).toBe(initialState);
  });
});
