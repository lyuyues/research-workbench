// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReplyableNote, SortableCards, mergeOrder, splitBlocks } from "./Cards";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("splitBlocks", () => {
  it("splits a note into the intro paragraph and top-level items, keeping continuation lines", () => {
    const md = "No note yesterday.\nSecond line, same paragraph.\n\n- **A**: one\n  more of A\n- B\n\n1. C";
    expect(splitBlocks(md)).toEqual(["No note yesterday.\nSecond line, same paragraph.", "- **A**: one\n  more of A", "- B", "1. C"]);
  });
});

describe("mergeOrder", () => {
  it("keeps the saved order, drops gone ids, appends new ones", () => {
    expect(mergeOrder(["c", "x", "a"], ["a", "b", "c"])).toEqual(["c", "a", "b"]);
    expect(mergeOrder([], ["a", "b"])).toEqual(["a", "b"]);
    // cards that load later go to their default place, not the end
    expect(mergeOrder(["timeline", "urgent"], ["tasks", "habits", "timeline", "urgent"])).toEqual(["tasks", "habits", "timeline", "urgent"]);
  });
});

describe("ReplyableNote", () => {
  it("double-click an item to reply; sends with that item as context", () => {
    const onReply = vi.fn();
    render(<ReplyableNote text={"intro\n\n- item one\n- item two"} base="daily_tracker.md" label="Claude's note" onReply={onReply} />);
    expect(screen.queryByRole("button", { name: /Reply/ })).toBeNull(); // no visible button
    fireEvent.doubleClick(screen.getByText("item two"));
    fireEvent.change(screen.getByLabelText("Reply to this item"), { target: { value: "Downgrade to blue" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
    expect(onReply).toHaveBeenCalledWith("Claude's note", "Claude's note\n\n- item two", "Downgrade to blue");
    expect(screen.queryByLabelText("Reply to this item")).toBeNull();
    expect(document.querySelector(".replied")).toBeTruthy();
  });

  it("can save a reply as a note instead", async () => {
    const onSaveNote = vi.fn(async () => null);
    render(<ReplyableNote text={"- only"} base="x.md" label="n" onSaveNote={onSaveNote} />);
    fireEvent.doubleClick(screen.getByText("only"));
    fireEvent.change(screen.getByLabelText("Reply to this item"), { target: { value: "ok" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as note" }));
    expect(onSaveNote).toHaveBeenCalledWith("- only", "ok");
  });
});

describe("SortableCards", () => {
  beforeEach(() => {
    const m = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k), clear: () => m.clear() });
  });
  const items = ["a", "b", "c"].map((id) => ({ id, label: id.toUpperCase(), node: <p>card {id}</p> }));
  it("moves a card with the arrow keys and remembers the order", () => {
    const { unmount } = render(<SortableCards storageKey="t" items={items} />);
    fireEvent.keyDown(screen.getByRole("button", { name: /Move C/ }), { key: "ArrowUp" });
    expect(screen.getAllByText(/^card /).map((e) => e.textContent)).toEqual(["card a", "card c", "card b"]);
    unmount();
    render(<SortableCards storageKey="t" items={items} />);
    expect(screen.getAllByText(/^card /).map((e) => e.textContent)).toEqual(["card a", "card c", "card b"]);
    expect(JSON.parse(localStorage.getItem("t")!)).toEqual(["a", "c", "b"]);
  });
});

describe("linksFor", () => {
  const all = { Alpha: { notion: "https://n/s" }, Beta: { notion: "https://n/v" }, "Third project": { notion: "https://n/j" } };
  it("matches project names loosely", async () => {
    const { linksFor } = await import("./Cards");
    expect(linksFor(all, "Alpha").notion).toBe("https://n/s");
    expect(linksFor(all, "**Beta**").notion).toBe("https://n/v");
    expect(linksFor(all, "Third project").notion).toBe("https://n/j");
    expect(linksFor(all, "Lit")).toEqual({});
  });
});

describe("slackPart", () => {
  it("takes only the Slack / Notion section of a recap", async () => {
    const { slackPart } = await import("./Meetings");
    const md = "<!-- x -->\n# T\n\n## Slack / Notion recap\n*Recap*\n1. A\n\n## Todos (the user)\n- [ ] B\n";
    expect(slackPart(md)).toBe("*Recap*\n1. A");
    expect(slackPart("## Slack / Notion recap\nonly\n")).toBe("only");
  });
});

describe("prettyRecap", () => {
  it("drops the draft marker and turns Slack *bold* into markdown bold only in the Slack section", async () => {
    const { prettyRecap } = await import("./Meetings");
    const md = "<!-- status: draft -->\n# T\n\n## Slack / Notion recap\n*Weekly recap — Nov 13*\n*📊 Alpha*\n1. Do *this*\n\n## Todos (the user)\n- [ ] keep *as is*\n";
    const out = prettyRecap(md);
    expect(out.startsWith("# T")).toBe(true);
    expect(out).toContain("**Weekly recap — Nov 13**");
    expect(out).toContain("**📊 Alpha**");
    expect(out).toContain("1. Do **this**");
    expect(out).toContain("keep *as is*");
  });
});

describe("ActionItems", () => {
  it("opens on the newest meeting with open items and switches by tab", async () => {
    const { ActionItems } = await import("./Meetings");
    const g = (date: string, checked: boolean[]) => ({ date, items: checked.map((c, k) => ({ id: `S-MEET-${k}`, line: k, raw: "", text: `${date} item ${k}`, checked: c, indent: 0 })) });
    render(<ActionItems groups={[g("2026-06-04", [true]), g("2026-11-13", [false, true]), g("2026-08-01", [false])]}
      render={(x) => x.items.map((i) => <p key={i.id}>{i.text}</p>)} />);
    expect(screen.getByText("2026-11-13 item 0")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Aug 1/ }));
    expect(screen.getByText("2026-08-01 item 0")).toBeTruthy();
  });
});

describe("NavTree", () => {
  beforeEach(() => {
    const m = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k), clear: () => m.clear() });
  });
  it("shows groups, opens the current panel's group, and expands others on click", async () => {
    const { NavTree } = await import("./Nav");
    const panels = ["today", "projects", "writing", "trends", "reading", "log", "automation", "new-one"].map((id) => ({ id, title: id }));
    const onGo = vi.fn();
    render(<NavTree panels={panels} current="trends" onGo={onGo} />);
    expect(screen.getByRole("button", { name: "Today" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "trends" })).toBeTruthy();        // Reading group opened for the current panel
    expect(screen.getByRole("button", { name: "Papers" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "writing" })).toBeNull();       // Projects still closed
    fireEvent.click(screen.getByRole("button", { name: /Projects/ }));
    fireEvent.click(screen.getByRole("button", { name: "writing" }));
    expect(onGo).toHaveBeenCalledWith("writing");
    expect(screen.getByRole("button", { name: "new-one" })).toBeTruthy();       // ungrouped panels still listed
  });
});

describe("Books", () => {
  it("lists recently opened books with progress, newest first", async () => {
    const { Books } = await import("./Books");
    const now = Math.floor(Date.now() / 1000);
    const book = (key: string, title: string, last: number | null, page: number | null = null, pages: number | null = null) => ({
      key, title, authors: ["A"], year: "", collections: ["6. BOOKS / Business"], tags: [], attachment: { format: "pdf" },
      reading: last ? { last_read: last, page, pages, percent: page && pages ? Math.round(100 * page / pages) : null } : null,
      audiobook: null, status: null });
    const demand = { ...book("K2", "Demand", now - 3 * 86400, 5, 210), readable: true };
    demand.reading = { ...demand.reading!, att: "ATT00002" } as typeof demand.reading;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ updated: now, books: [
      book("K1", "Old book", now - 90 * 86400, 10), demand,
      book("K3", "Never opened", null), book("K4", "Signals", now - 86400, 2)] }))));
    render(<Books onAsk={() => {}} onPrompt={() => {}} />);
    const titles = (await screen.findAllByText(/Signals|Demand/)).map((e) => e.textContent);
    expect(titles[0]).toBe("Signals");
    expect(screen.getByText(/p\. 5 \/ 210/)).toBeTruthy();
    expect(screen.queryByText("Never opened")).toBeNull();
    expect(screen.getByText(/1 books opened before/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Read here" })).toHaveLength(1);   // only books with a server copy
    expect(screen.getAllByRole("link", { name: "Open in Zotero" })[0].getAttribute("href"))
      .toBe("zotero://open-pdf/library/items/ATT00002?page=5");
  });
});

describe("Books Read here", () => {
  it("opens the book in the Reading reader", async () => {
    const { Books } = await import("./Books");
    const { fireEvent } = await import("@testing-library/react");
    const now = Math.floor(Date.now() / 1000);
    const b = { key: "R7PP6DBN", title: "Jung", authors: ["A"], year: "", collections: ["6. BOOKS / Life"], tags: [],
      attachment: { key: "ATT00009", format: "pdf" }, reading: { last_read: now, page: 9, pages: 401, percent: 2.2 },
      audiobook: null, status: null, readable: true };
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${u}`);
      return new Response(JSON.stringify(u.endsWith("/read") ? { id: "jung-1", new: true } : { updated: now, books: [b] }));
    }));
    window.location.hash = "#/books";
    render(<Books onAsk={() => {}} onPrompt={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Read here" }));
    await vi.waitFor(() => expect(window.location.hash).toBe("#/reading/jung-1"));
    expect(calls).toContain("POST /api/bookshelf/R7PP6DBN/read");
  });
});

describe("QuestionsCard", () => {
  it("shows waiting questions with a reply box, and nothing when there are none", async () => {
    const { QuestionsCard } = await import("./Annotations");
    const block = { id: "a", path: "Alpha/paper/outline.md", line: 3, end_line: 5, end_raw: "> q", meta: "", heading: "RQs",
      text: "Keep RQ3 as is?", replied: false, mtime: Date.now() };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ blocks: [block], pending: 1 }))));
    const { unmount } = render(<QuestionsCard onAsk={() => {}} onPrompt={() => {}} onError={() => {}} />);
    expect(await screen.findByText("Keep RQ3 as is?")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save reply" })).toBeNull();   // only after a double-click
    fireEvent.doubleClick(screen.getByText("Keep RQ3 as is?"));
    expect(screen.getByRole("button", { name: "Save reply" })).toBeTruthy();
    unmount();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ blocks: [], pending: 0 }))));
    const r = render(<QuestionsCard onAsk={() => {}} onPrompt={() => {}} onError={() => {}} />);
    await new Promise((x) => setTimeout(x, 20));
    expect(r.container.textContent).toBe("");
  });
});

describe("FileView annotations", () => {
  it("double-click a ⚠️ question in an open file to answer it in place", async () => {
    const { FileView } = await import("./common");
    const md = "# Qs\n\n## Q2\n\n> ⚠️ **Question for you** (Q2)\n> Which site?\n\n## Q3\n\n> ⚠️ **Question for you** (Q3)\n> Tempo in or out?\n";
    const posts: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/edit/annotation-reply")) { posts.push(JSON.parse(String(init!.body))); return new Response("{}"); }
      return new Response(JSON.stringify({ text: md, mtime: 1 }));
    }));
    render(<FileView path="Alpha/paper/_open_questions/q.md" />);
    fireEvent.doubleClick(await screen.findByText(/Tempo in or out/));
    fireEvent.change(screen.getByLabelText("Your answer"), { target: { value: "out" } });
    fireEvent.click(screen.getByRole("button", { name: "Save answer" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(posts[0]).toEqual({ path: "Alpha/paper/_open_questions/q.md", line: 10, end_line: 11, end_raw: "> Tempo in or out?", text: "out" });
  });
});

describe("Undo after ticking", () => {
  it("shows an Undo toast that unticks the same line", async () => {
    const { CheckItem, Toasts } = await import("./common");
    const bodies: { checked: boolean; expect: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => {
      const b = JSON.parse(String(init!.body)); bodies.push(b);
      return new Response(JSON.stringify({ line: 5, raw: b.checked ? "- [x] O-MEET1113-1 Practice" : "- [ ] O-MEET1113-1 Practice" }));
    }));
    const item = { line: 5, raw: "- [ ] O-MEET1113-1 Practice", text: "O-MEET1113-1 Practice", checked: false, indent: 0 };
    render(<><CheckItem path="research_tasks.md" item={item} onDone={() => {}} onError={() => {}} /><Toasts /></>);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(bodies.map((b) => [b.checked, b.expect])).toEqual([[true, "- [ ] O-MEET1113-1 Practice"], [false, "- [x] O-MEET1113-1 Practice"]]);
  });
});

describe("FileView editing markdown", () => {
  it("hides front matter, edits with a preview and saves through onSave", async () => {
    const { FileView } = await import("./common");
    const { fireEvent, waitFor } = await import("@testing-library/react");
    const text = "---\nmarp: true\n---\n# Done this week\n- one\n";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ text, mtime: 1 }))));
    const onSave = vi.fn(async () => null);
    render(<FileView path="meetings/group/2026-11-25_slides.md" onSave={onSave} />);
    await screen.findByText("Done this week");
    expect(screen.queryByText(/marp: true/)).toBeNull();
    fireEvent.click(screen.getByText("✎ Edit"));
    fireEvent.change(screen.getByLabelText("Edit file"), { target: { value: text + "- two\n" } });
    fireEvent.click(screen.getByText("Save (⌘S)"));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(text + "- two\n", text));
    await screen.findByText(/Saved/);
  });
});
