// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MyBooks, buildTree, matches } from "./MyBooks";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const b = (key: string, title: string, collections: string[], extra = {}) => ({
  key, title, authors: ["Camus"], year: "2013", collections, tags: [],
  attachment: { key: "A", format: "pdf", file: "x.pdf", size: 1 }, file_on_mac: true, audiobook: null, status: null, error: null, ...extra,
});
const shelf = { updated: 1794700000, books: [
  b("K1", "The Rebel", ["6. BOOKS / Literature / Camus"]),
  b("K2", "A brief history of time", ["6. BOOKS / Physics"], { authors: ["Hawking, Stephen"] }),
  b("K3", "Market Signaling", ["6. BOOKS / Economics"], { audiobook: "slug1" }),
  b("K4", "No file", ["6. BOOKS / Literature"], { attachment: null, file_on_mac: false }),
  b("K5", "Handbook of AR", ["1. RESEARCH MAP / AR"]),
] };

describe("MyBooks", () => {
  it("builds a folder tree with subtree counts, bookshelf first", () => {
    const t = buildTree(shelf.books as never);
    expect(t.map((n) => n.name)).toEqual(["6. BOOKS", "1. RESEARCH MAP"]);
    expect(t[0].count).toBe(4);
    const lit = t[0].children.find((n) => n.name === "Literature")!;
    expect(lit.count).toBe(2);
    expect(lit.children.map((n) => n.name)).toEqual(["Camus"]);
    expect(matches(shelf.books[1] as never, "hawking time")).toBe(true);
  });
  it("browses folders by level, searches, requests and listens", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") { calls.push(url); return new Response("{}"); }
      return new Response(JSON.stringify(shelf));
    }));
    const onListen = vi.fn();
    render(<MyBooks onListen={onListen} />);
    expect(await screen.findByText("The Rebel")).toBeTruthy();
    expect(screen.queryByText("Handbook of AR")).toBeNull(); // default = 6. BOOKS
    const tree = screen.getByRole("tree");
    fireEvent.click(within(tree).getByRole("button", { name: "Expand Literature" }));
    fireEvent.click(within(tree).getByRole("button", { name: "Camus" }));
    expect(screen.queryByText("No file")).toBeNull();
    expect(screen.getByText("The Rebel")).toBeTruthy();
    fireEvent.click(within(tree).getByRole("button", { name: "Literature" }));
    expect(screen.getByText("No file")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    fireEvent.change(screen.getByLabelText("Search books"), { target: { value: "handbook" } });
    expect(screen.getByText("Handbook of AR")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Make audiobook" }));
    await vi.waitFor(() => expect(calls).toEqual(["/api/bookshelf/K5/audiobook"]));
    fireEvent.change(screen.getByLabelText("Search books"), { target: { value: "Market" } });
    fireEvent.click(screen.getByRole("button", { name: "▶ Listen" }));
    expect(onListen).toHaveBeenCalledWith("slug1");
  });
});

describe("progressText", () => {
  it("describes each stage", async () => {
    const { progressText } = await import("./MyBooks");
    expect(progressText(null)).toBe("Waiting to convert…");
    expect(progressText({ stage: "ocr", done: 30, total: 120 })).toBe("OCR 30/120 pages (25%)");
    expect(progressText({ stage: "tts", done: 2, total: 10 })).toBe("Recording episode 3/10 (2 ready)");
  });
});
