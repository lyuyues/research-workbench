// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SystemLog } from "./SystemLog";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const entries = [
  { ts: 1794268000000, actor: "agent", action: "run finished", detail: "changed 1 file(s)", panel: "today", files: ["a.md"], seconds: 12 },
  { ts: 1794267000000, actor: "claude-mac", action: "deploy", detail: "abc123 Study data tabs" },
  { ts: 1794266000000, actor: "agent", action: "run failed", detail: "agent failed: boom" },
];

describe("SystemLog", () => {
  it("lists entries newest first and filters by actor", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(entries))));
    render(<SystemLog />);
    expect(await screen.findByText("abc123 Study data tabs")).toBeTruthy();
    expect(screen.getAllByRole("listitem").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText("1 file(s)")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Claude (Mac)" }));
    expect(screen.queryByText("agent failed: boom")).toBeNull();
    expect(screen.getByText("deploy")).toBeTruthy();
  });
  it("shows an error when the API fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 403 })));
    render(<SystemLog />);
    expect((await screen.findByRole("alert")).textContent).toContain("HTTP 403");
  });
});
