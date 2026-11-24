// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./PdfView", () => ({
  clampZoom: (z: number) => Math.min(3, Math.max(0.5, z)),
  PdfView: ({ onSelect, onPage, jump }: { onSelect: (s: unknown) => void; onPage?: (p: number) => void; jump: { page: number } | null }) => (
    <>
      <button onClick={() => onSelect({ page: 1, rects: [[1, 2, 3, 4]], text: "a key passage", top: 4, page_height: 792, x: 0, y: 0 })}>
        fake-select</button>
      <button onClick={() => onPage?.(12)}>fake-scroll</button>
      <span>jump:{jump ? jump.page : "none"}</span>
    </>),
}));
import { Reading, READ_PROMPTS } from "./Reading";
import type { Paper } from "./Reading";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status });
const COLORS = { yellow: "#ffd400", red: "#ff6666" };
const PAPER: Paper = {
  id: "arxiv-2611.01234", title: "Creative Intent", authors: ["A Lee", "B Wu"], year: "2026", venue: "", doi: "", arxiv: "2611.01234",
  url: "https://arxiv.org/abs/2611.01234", pdf_url: "", source: "trends", added: Date.now(), status: "reading", zotero_want: false,
  notes: "literature-radar/reading-notes/Creative-Intent.md", pdf: "reading/pdfs/arxiv-2611.01234.pdf", pdf_state: "ok", pdf_error: null,
  highlights: 1, notes_exists: true, zotero: { state: "off", key: null, attachment_key: null, synced_at: null, error: null, bridge_state: null },
};
const LIB = { papers: [PAPER], zotero_configured: false, bridge_updated: null, index_updated: null, collection: null, colors: COLORS };
const DETAIL = {
  paper: PAPER, colors: COLORS, zotero_highlights: [],
  highlights: [{ id: "h1", page: 0, rects: [[1, 2, 3, 4]], top: 4, text: "first highlight", comment: "", color: "yellow" }],
  notes: { path: PAPER.notes, exists: true, mtime: 0,
    text: "# Creative Intent\n\n## My notes\n\nold\n\n<!-- highlights:start · x -->\n## Highlights\n<!-- highlights:end -->\n" },
};

describe("Reading", () => {
  it("lists papers, opens one, highlights a selection and asks the agent", async () => {
    const posts: [string, unknown][] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push([url, JSON.parse(String(init.body ?? "{}"))]);
        return json(url.endsWith("/highlights") ? { id: "h2" } : { ok: true });
      }
      if (url === "/api/reading") return json(LIB);
      if (url.startsWith("/api/reading/paper/")) return json(DETAIL);
      return json({}, 404);
    }));
    const onAsk = vi.fn();
    render(<Reading onAsk={onAsk} onPrompt={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Creative Intent" }));
    expect(await screen.findByText("first highlight")).toBeTruthy();
    fireEvent.click(screen.getByText("fake-select"));
    fireEvent.click(screen.getByLabelText("Highlight red"));
    await waitFor(() => expect(posts.some(([u]) => u.endsWith("/highlights"))).toBe(true));
    const hl = posts.find(([u]) => u.endsWith("/highlights"))![1] as { color: string; page: number; text: string };
    expect(hl).toMatchObject({ color: "red", page: 1, text: "a key passage" });
    fireEvent.click(screen.getByText("fake-select"));
    fireEvent.click(screen.getAllByRole("button", { name: "Ask agent" })[0]);
    expect(onAsk).toHaveBeenCalledWith(expect.stringContaining("p.2"), expect.stringContaining('Passage (page 2 of the PDF): "a key passage"'));
    // notes editor hides the generated block and saves with the original as `expect`
    fireEvent.click(screen.getByRole("tab", { name: /Notes/ }));
    const area = screen.getByLabelText("Notes") as HTMLTextAreaElement;
    expect(area.value).not.toContain("highlights:start");
    fireEvent.change(area, { target: { value: area.value + "new idea\n" } });
    fireEvent.click(screen.getByText("Save notes"));
    await waitFor(() => expect(posts.some(([u]) => u.endsWith("/notes"))).toBe(true));
    const n = posts.find(([u]) => u.endsWith("/notes"))![1] as { text: string; expect: string };
    expect(n.text).toContain("new idea");
    expect(n.expect).toBe(DETAIL.notes.text);
  });

  it("opens at the shared (Zotero) reading position and saves the page as you read", async () => {
    window.location.hash = "#/reading";
    const posts: [string, unknown][] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") { posts.push([url, JSON.parse(String(init.body ?? "{}"))]); return json({ ok: true }); }
      if (url === "/api/reading") return json(LIB);
      if (url.endsWith("/position")) return json({ page: 20, source: "zotero" });
      if (url.startsWith("/api/reading/paper/")) return json(DETAIL);
      return json({}, 404);
    }));
    render(<Reading onAsk={() => {}} onPrompt={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Creative Intent" }));
    expect(await screen.findByText("jump:20")).toBeTruthy();
    fireEvent.click(screen.getByText("fake-scroll"));
    await waitFor(() => expect(posts.find(([u]) => u.endsWith("/position"))?.[1]).toEqual({ page: 12 }), { timeout: 3500 });
  });

  it("shows notes written in Zotero read-only under the editor", async () => {
    window.location.hash = "#/reading";
    const text = "# Creative Intent\n\nmine\n\n<!-- highlights:start · x -->\n## Highlights\n\n<!-- zotero-notes · y -->\n## From Zotero\n\nJung on **persona**\n\n<!-- highlights:end -->\n";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/reading") return json(LIB);
      if (url.endsWith("/position")) return json({ page: null });
      if (url.startsWith("/api/reading/paper/")) return json({ ...DETAIL, notes: { ...DETAIL.notes, text } });
      return json({}, 404);
    }));
    render(<Reading onAsk={() => {}} onPrompt={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Creative Intent" }));
    fireEvent.click(await screen.findByRole("tab", { name: /Notes/ }));
    const box = screen.getByRole("region", { name: "Notes from Zotero" });
    expect(box.textContent).toContain("persona");
    expect((screen.getByLabelText("Notes") as HTMLTextAreaElement).value).not.toContain("persona");
  });

  it("builds prompts that name the PDF and notes file", () => {
    expect(READ_PROMPTS.full(PAPER)).toContain("reading/pdfs/arxiv-2611.01234.pdf");
    expect(READ_PROMPTS.save(PAPER)).toContain(PAPER.notes);
  });
});

describe("Reading tags and stars", () => {
  it("rates a paper, adds a tag and filters by it", async () => {
    window.location.hash = "#/reading";
    const posts: unknown[] = [];
    const tagged = { ...PAPER, id: "t-other", title: "Other paper", tags: ["Alpha"], rating: 5 };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") { posts.push(JSON.parse(String(init.body))); return json({ ok: true }); }
      if (url === "/api/reading") return json({ ...LIB, papers: [PAPER, tagged] });
      return json({}, 404);
    }));
    render(<Reading onAsk={() => {}} onPrompt={() => {}} />);
    await screen.findByRole("button", { name: "Creative Intent" });
    fireEvent.click(screen.getAllByRole("radio", { name: "4 stars" })[0]);
    await waitFor(() => expect(posts).toContainEqual({ rating: 4 }));
    fireEvent.click(screen.getAllByText("+ tag")[0]);
    const input = screen.getByLabelText("New tag");
    fireEvent.change(input, { target: { value: "#video" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(posts).toContainEqual({ tags: ["video"] }));
    fireEvent.click(screen.getByRole("button", { name: "Alpha", pressed: false }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Creative Intent" })).toBeNull());
    expect(screen.getByRole("button", { name: "Other paper" })).toBeTruthy();
  });
});

describe("Reading papers vs books", () => {
  it("keeps books on their own tab and counts statuses within the tag filter", async () => {
    window.location.hash = "#/reading";
    const book = { ...PAPER, id: "t-book", title: "A Book", tags: ["book"], status: "reading" as const };
    const todo = { ...PAPER, id: "t-todo", title: "Tagged todo", tags: ["DeepMind"], status: "to-read" as const };
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url === "/api/reading" ? json({ ...LIB, papers: [PAPER, book, todo] }) : json({}, 404)));
    render(<Reading onAsk={() => {}} onPrompt={() => {}} />);
    await screen.findByRole("button", { name: "Creative Intent" });
    expect(screen.getByRole("tab", { name: "Papers 2" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "A Book" })).toBeNull();
    expect(screen.queryByRole("button", { name: "book", pressed: false })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "DeepMind", pressed: false }));
    expect(await screen.findByRole("tab", { name: "To read 1" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Reading 0" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Books 1" }));
    expect(await screen.findByRole("button", { name: "A Book" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Creative Intent" })).toBeNull();
  });
});

describe("Outline", () => {
  it("lists the contents, marks the current section and jumps on click", async () => {
    const { Outline } = await import("./Reading");
    const items = [
      { title: "Part I", page: 0, items: [{ title: "Ch 1", page: 2, items: [] }, { title: "Ch 2", page: 10, top: 500, items: [] }] },
      { title: "Part II", page: 40, items: [{ title: "Ch 3", page: 41, items: [] }] },
    ];
    const onGo = vi.fn();
    render(<Outline items={items} current={12} onGo={onGo} />);
    expect(screen.getByRole("button", { name: "Ch 2" }).getAttribute("aria-current")).toBe("location");
    fireEvent.click(screen.getByRole("button", { name: "Ch 3" }));
    expect(onGo).toHaveBeenCalledWith(expect.objectContaining({ title: "Ch 3", page: 41 }));
    fireEvent.click(screen.getAllByRole("button", { name: "Collapse" })[1]);   // fold Part II
    expect(screen.queryByRole("button", { name: "Ch 3" })).toBeNull();
  });
});
