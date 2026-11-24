// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentChat } from "./AgentChat";
import { DISCONNECTED_MESSAGE } from "./agentReducer";
import { FakeWebSocket } from "./testWebSocket";

const sockets = () => FakeWebSocket.instances;
const last = () => sockets()[sockets().length - 1];

function type(text: string) {
  fireEvent.change(screen.getByLabelText("Message to the agent"), { target: { value: text } });
}
async function sendPrompt(text: string) {
  type(text);
  await act(async () => { fireEvent.click(screen.getByText("Send")); });
}
async function server(fn: () => void) {
  await act(async () => { fn(); });
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  // jsdom has no layout; scrollHeight is fine as 0
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AgentChat", () => {
  it("pasted images show as thumbnails and are sent with the prompt", async () => {
    render(<AgentChat panel="story" />);
    const file = new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });
    await act(async () => {
      fireEvent.paste(screen.getByLabelText("Message to the agent"), {
        clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => file }] },
      });
    });
    await waitFor(() => expect(screen.getByAltText("Pasted image 1")).toBeTruthy());
    await act(async () => { fireEvent.click(screen.getByText("Send")); }); // image alone is enough
    await server(() => last().open());
    const msg = last().sent[0] as { prompt: string; images: string[] };
    expect(msg.prompt).toBe("(see image)");
    expect(msg.images).toHaveLength(1);
    expect(msg.images[0].startsWith("data:image/png;base64,")).toBe(true);
    expect(screen.queryByAltText("Pasted image 1")).toBeNull();
  });

  it("omits session_id while null, sends it once known", async () => {
    render(<AgentChat panel="today" />);
    await sendPrompt("one");
    await server(() => last().open());
    expect(last().sent[0]).toEqual({ prompt: "one", context: { panel: "today" } });
    await server(() => {
      last().emit({ kind: "started" });
      last().emit({ kind: "session", session_id: "s1" });
      last().emit({ kind: "done", session_id: "s1", is_error: false });
    });
    expect(screen.getByText("Saving changes…")).toBeTruthy();
    expect(screen.queryByText("Send")).toBeNull(); // still blocked until changes
    await server(() => last().emit({ kind: "changes", commit: null, files: [] }));
    await sendPrompt("two");
    expect(sockets()).toHaveLength(1);
    expect(last().sent[1]).toEqual({ prompt: "two", context: { panel: "today" }, session_id: "s1" });
  });

  it("send and stop while CONNECTING share one socket", async () => {
    render(<AgentChat panel="today" />);
    await sendPrompt("hi");
    await act(async () => { fireEvent.click(screen.getByText("Stop")); });
    expect(sockets()).toHaveLength(1);
    await server(() => last().open());
    expect(last().sent).toEqual([{ prompt: "hi", context: { panel: "today" } }, { type: "cancel" }]);
  });

  it("connect timeout closes the socket, returns to idle and restores the draft", async () => {
    render(<AgentChat panel="today" connectTimeoutMs={20} />);
    await sendPrompt("hello");
    await waitFor(() => expect(screen.getByText("Connection timed out")).toBeTruthy());
    expect(last().readyState).toBe(FakeWebSocket.CLOSED);
    expect(screen.getByText("Send")).toBeTruthy();
    expect((screen.getByLabelText("Message to the agent") as HTMLTextAreaElement).value).toBe("hello");
    expect(screen.queryByText(DISCONNECTED_MESSAGE)).toBeNull();
  });

  it("a stale socket closing later does not report a disconnect", async () => {
    render(<AgentChat panel="today" />);
    await sendPrompt("a");
    const stale = last();
    await server(() => stale.onerror?.()); // connect fails, but the close event comes later
    await sendPrompt("b");
    expect(sockets()).toHaveLength(2);
    await server(() => { last().open(); last().emit({ kind: "started" }); });
    await server(() => stale.close());
    expect(screen.queryByText(DISCONNECTED_MESSAGE)).toBeNull();
    expect(screen.getByText("Stop")).toBeTruthy();
  });

  it("no-run error right after send restores the text", async () => {
    render(<AgentChat panel="today" />);
    await sendPrompt("busy?");
    await server(() => { last().open(); last().emit({ kind: "error", message: "Another agent task is already running" }); });
    expect(screen.getByText("Send")).toBeTruthy();
    expect((screen.getByLabelText("Message to the agent") as HTMLTextAreaElement).value).toBe("busy?");
  });

  it("stop sends cancel on the open socket", async () => {
    render(<AgentChat panel="today" />);
    await sendPrompt("x");
    await server(() => { last().open(); last().emit({ kind: "started" }); });
    await act(async () => { fireEvent.click(screen.getByText("Stop")); });
    expect(last().sent[last().sent.length - 1]).toEqual({ type: "cancel" });
    await server(() => last().emit({ kind: "error", message: "cancelled" }));
    expect(screen.getByText("Saving changes…")).toBeTruthy();
  });

  it("disconnect mid-run offers Stop background task, which cancels over a new socket", async () => {
    render(<AgentChat panel="today" />);
    await sendPrompt("x");
    await server(() => { last().open(); last().emit({ kind: "started" }); });
    await server(() => last().close());
    expect(screen.getByText(DISCONNECTED_MESSAGE)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByText("Stop background task")); });
    expect(sockets()).toHaveLength(2);
    await server(() => last().open());
    expect(last().sent).toEqual([{ type: "cancel" }]);
    expect(screen.getByText("Requested stop of background task")).toBeTruthy();
    expect(screen.queryByText("Stop background task")).toBeNull();
  });

  it("unparseable server message becomes a notice", async () => {
    render(<AgentChat panel="today" />);
    await sendPrompt("x");
    await server(() => { last().open(); last().emit({ kind: "started" }); last().emit("{oops"); });
    expect(screen.getByText(/Could not parse server message/)).toBeTruthy();
    expect(screen.getByText("Stop")).toBeTruthy();
  });

  it("undo is disabled during a run; a 409 shows detail and leaves run state alone", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ detail: "agent running" }), { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentChat panel="today" />);
    await sendPrompt("w");
    await server(() => {
      last().open();
      last().emit({ kind: "started" });
      last().emit({ kind: "changes", commit: "abcdef1234", files: ["a.md"] });
    });
    await sendPrompt("again");
    await server(() => last().emit({ kind: "started" }));
    const undoBtn = screen.getByLabelText(/Undo this change/) as HTMLButtonElement;
    expect(undoBtn.disabled).toBe(true);
    await server(() => last().emit({ kind: "changes", commit: null, files: [] }));
    expect(undoBtn.disabled).toBe(false);
    await act(async () => { fireEvent.click(undoBtn); fireEvent.click(undoBtn); });
    await waitFor(() => expect(screen.getByText("Undo failed: agent running")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Send")).toBeTruthy();
    expect((screen.getByLabelText(/Undo this change/) as HTMLButtonElement).disabled).toBe(false);
  });

  it("undo 200 marks the item undone", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ head: "h" }), { status: 200 })));
    render(<AgentChat panel="today" />);
    await sendPrompt("w");
    await server(() => {
      last().open();
      last().emit({ kind: "started" });
      last().emit({ kind: "changes", commit: "abcdef1234", files: ["a.md"] });
    });
    await act(async () => { fireEvent.click(screen.getByLabelText(/Undo this change/)); });
    await waitFor(() => expect(screen.getByText("Undone")).toBeTruthy());
  });
});
