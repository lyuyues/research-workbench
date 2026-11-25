// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Brain } from "./Brain";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const idle = { running: false, error: null, zotero_configured: true,
  last: { timestamp: "2026-11-24T07:45:00-08:00", new_highlights: 3, new_sources: 1 } };

describe("Brain", () => {
  it("embeds the map page and starts a Zotero refresh", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (init?.method === "POST") return new Response(JSON.stringify({ started: true }));
      return new Response(JSON.stringify(idle));
    }));
    const { container } = render(<Brain />);
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("src")).toBe("/brain/index.html");
    const btn = await screen.findByRole("button", { name: "Refresh from Zotero" });
    expect(await screen.findByText(/Last import: (?!never)/)).toBeTruthy();
    fireEvent.click(btn);
    expect(await screen.findByRole("button", { name: "Refreshing…" })).toBeTruthy();
    expect(calls).toContain("POST /api/brain/import");
  });

  it("disables refresh when Zotero is not configured", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...idle, zotero_configured: false,
      last: { timestamp: null, new_highlights: 0, new_sources: 0 } }))));
    render(<Brain />);
    expect(await screen.findByText("Last import: never")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Refresh from Zotero" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
