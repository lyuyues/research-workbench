// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { FakeWebSocket } from "./testWebSocket";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("App", () => {
  it("shows an error state when /api/panels fails", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>login</html>", { status: 403 })));
    render(<App />);
    expect(await screen.findByText("Could not load (HTTP 403) — you may need to sign in again")).toBeTruthy();
  });
  it("shows an error state when /api/panels is not a list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "x" }), { status: 200 })));
    render(<App />);
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
  it("renders panels and marks the active one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
      { id: "today", title: "Today", phase: 2 }, { id: "writing", title: "Writing", phase: 4 }]), { status: 200 })));
    render(<App />);
    const btn = await screen.findByRole("button", { name: "Today" });
    expect(btn.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Today");
  });
  it("viewers get a read-only layout without the agent", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const writing = { papers: [{ name: "Alpha", overleaf: null, words: 400, pdf: null, docs: [],
      sections: [{ name: "intro.tex", path: "Alpha/paper/overleaf/texfiles/intro.tex", words: 400, todos: 0, status: "written", mtime: 0 }] }] };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(
      url === "/api/me" ? { email: "c@example.edu", role: "viewer", panels: ["writing"] }
        : url === "/api/panels" ? [{ id: "writing", title: "Writing", phase: 4, ready: true }]
        : writing), { status: 200 })));
    render(<App />);
    expect(await screen.findByText("intro")).toBeTruthy();
    expect(await screen.findByText(/Read-only view shared by the user/)).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Writing");
    expect(screen.queryByRole("button", { name: "Agent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Ask" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume demo work" })).toBeNull();
    expect(document.querySelector("#agent-drawer")).toBeNull();
  });
});
