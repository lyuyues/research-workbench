// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveLink } from "./common";
import { Today } from "./Today";
import { Annotations } from "./Annotations";
import { Weekly } from "./Weekly";
import { Trends } from "./Trends";
import { Meetings, PROMPTS } from "./Meetings";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status });

const DAILY = {
  available: true, path: "daily_tracker.md", mtime: 0, today: "2026-11-10",
  entries: [{ date: "2026-11-10", title: "2026-11-10 (Tue)", line: 10, sections: [
    { title: "Tasks", line: 12, kind: "tasks", quote: "", last_line: 13, last_raw: "",
      items: [{ line: 13, text: "do **it**", checked: false, raw: "- [ ] do **it**" }] },
    { title: "Claude reply", line: 20, kind: "reply", quote: "hi there", last_line: 21, last_raw: "> hi there", items: [] },
  ] }],
};
const TASKS = { dashboard: { header: [], rows: [] }, updated: "2026-11-09", mtime: 0, groups: [] };

describe("resolveLink", () => {
  it("resolves relative to the file and keeps anchors", () => {
    expect(resolveLink("../reading-notes/a.md#x", "literature-radar/digests/w.md"))
      .toEqual({ path: "literature-radar/reading-notes/a.md", anchor: "x" });
    expect(resolveLink("Alpha/a.md", "daily_tracker.md")).toEqual({ path: "Alpha/a.md", anchor: null });
  });
  it("leaves external links and escapes alone", () => {
    expect(resolveLink("https://doi.org/1", "a.md")).toBeNull();
    expect(resolveLink("../../x.md", "a.md")).toBeNull();
  });
});

describe("Today", () => {
  it("renders tasks and ticks a checkbox through the API", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/daily") return json(DAILY);
      if (url === "/api/tasks") return json(TASKS);
      if (url === "/api/edit/checkbox") return json({ ok: true, body: init?.body });
      return json({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Today onAsk={() => {}} onPrompt={() => {}} />);
    const box = await screen.findByRole("checkbox");
    expect(await screen.findByText("hi there")).toBeTruthy();
    fireEvent.click(box);
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === "/api/edit/checkbox")).toBe(true));
    const call = fetchMock.mock.calls.find(([u]) => u === "/api/edit/checkbox")!;
    expect(JSON.parse(String(call[1]!.body))).toEqual({ path: "daily_tracker.md", line: 13, expect: "- [ ] do **it**", checked: true });
  });

  it("turns the (add your own here) placeholder into an input that adds a task", async () => {
    const daily = structuredClone(DAILY);
    daily.entries[0].sections[0].items.push({ line: 14, text: "(add your own here)", checked: false, raw: "- [ ] (add your own here)" });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/daily") return json(daily);
      if (url === "/api/tasks") return json(TASKS);
      if (url === "/api/today/task") return json({ line: 14, body: init?.body });
      return json({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Today onAsk={() => {}} onPrompt={() => {}} />);
    const input = await screen.findByLabelText("Add your own task");
    expect(screen.queryByText("(add your own here)")).toBeNull();
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    fireEvent.change(input, { target: { value: "  call the clinic  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === "/api/today/task")).toBe(true));
    const call = fetchMock.mock.calls.find(([u]) => u === "/api/today/task")!;
    expect(JSON.parse(String(call[1]!.body))).toEqual({ text: "call the clinic" });
  });

  it("shows the server's conflict message and reverts the box", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/daily") return json(DAILY);
      if (url === "/api/tasks") return json(TASKS);
      return json({ detail: "the file changed since it was loaded — reload and try again" }, 409);
    }));
    render(<Today onAsk={() => {}} onPrompt={() => {}} />);
    const box = (await screen.findByRole("checkbox")) as HTMLInputElement;
    fireEvent.click(box);
    expect(await screen.findByText(/the file changed/)).toBeTruthy();
    expect(box.checked).toBe(false);
  });

  it("quick actions prefill the agent prompt", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => json(url === "/api/daily" ? DAILY : TASKS)));
    const onPrompt = vi.fn();
    render(<Today onAsk={() => {}} onPrompt={onPrompt} />);
    fireEvent.click(await screen.findByRole("button", { name: "Plan my day" }));
    expect(onPrompt).toHaveBeenCalledWith(expect.stringContaining("Plan my day"));
  });
});

describe("Annotations", () => {
  it("saves a reply", async () => {
    const fetchMock = vi.fn(async (url: string) => url === "/api/annotations"
      ? json({ pending: 1, blocks: [{ id: "a:3", path: "Alpha/doc.md", line: 3, end_line: 5, end_raw: "> 2. Q?",
          meta: "(2026-06-11)", heading: "Sec", text: "1. Q?", replied: false, mtime: 0 }] })
      : json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    render(<Annotations onAsk={() => {}} onPrompt={() => {}} />);
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "my answer" } });
    fireEvent.click(screen.getByRole("button", { name: "Save reply" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === "/api/edit/annotation-reply")).toBe(true));
  });
});

describe("Weekly", () => {
  it("shows totals per project", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      week_start: "2026-11-09", week_end: "2026-11-15", today: "2026-11-10", total_minutes: 90,
      entries: [], by_project: [{ project: "Alpha", minutes: 90 }],
      by_day: Array.from({ length: 7 }, (_, i) => ({ date: `2026-11-${9 + i}`, minutes: i ? 0 : 90 })),
      habits: [], reports: [],
    })));
    render(<Weekly onAsk={() => {}} onPrompt={() => {}} />);
    expect(await screen.findByText("Alpha")).toBeTruthy();
    expect(screen.getAllByText("1h 30m").length).toBeGreaterThan(0);
  });
});

describe("Trends", () => {
  const CONFIG = { topics: [{ id: "vr", name: "VR", keywords: ["sleep"] }, { id: "agent", name: "AI agent", keywords: ["agentic"] }],
    sources: [{ name: "OpenAI", url: "https://openai.com/news/rss.xml", kind: "lab", all: true, enabled: true }],
    arxiv: { enabled: true, categories: ["cs.HC"], max_per_topic: 40 }, hn: { enabled: true, min_points: 30 } };
  const VIEW = { days: ["2026-11-10"], day: "2026-11-10", config: CONFIG, headline: "Today's key points", errors: [], generated: 0, summarized: true,
    items: [
      { id: "a", title: "Agents paper", url: "https://arxiv.org/abs/1", source: "arXiv cs.AI", kind: "academic", published: null, snippet: "s",
        topics: ["agent"], zh: "An agent paper", relevance: 1, why: null },
      { id: "b", title: "Sleep AR app raises money", url: "https://tc.com/x", source: "TechCrunch AI", kind: "industry", published: null, snippet: "s",
        topics: ["vr"], zh: "Funding news", relevance: 3, why: "Related to Alpha" }] };

  it("filters by type and topic, sorts by relevance, saves settings", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
      url === "/api/trends/config" ? json(JSON.parse(String(init?.body)).config) : json(VIEW));
    vi.stubGlobal("fetch", fetchMock);
    render(<Trends onAsk={() => {}} onPrompt={() => {}} />);
    expect(await screen.findByText("Today's key points")).toBeTruthy();
    const titles = () => screen.getAllByRole("link").map((a) => a.textContent);
    expect(titles()).toEqual(["Sleep AR app raises money", "Agents paper"]);
    expect(screen.getByText("↳ Related to Alpha")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Academic 1" }));
    expect(titles()).toEqual(["Agents paper"]);
    fireEvent.click(screen.getByRole("tab", { name: "All 2" }));
    fireEvent.click(screen.getByRole("button", { name: "VR" }));
    expect(titles()).toEqual(["Sleep AR app raises money"]);
    fireEvent.click(screen.getByRole("button", { name: "Topics & sources" }));
    fireEvent.change(screen.getByLabelText("Keywords for VR"), { target: { value: "sleep, sleepy\nVR" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === "/api/trends/config")).toBe(true));
    const body = JSON.parse(String(fetchMock.mock.calls.find(([u]) => u === "/api/trends/config")![1]!.body));
    expect(body.config.topics[0].keywords).toEqual(["sleep", "sleepy", "VR"]);
  });
});

describe("Meetings", () => {
  const VIEW = { now: Date.UTC(2026, 10, 10, 23), questions_path: "meetings/questions.md",
    kinds: {
      advisor: { title: "Advisor meeting (the advisor)", next: Date.UTC(2026, 10, 13, 15), next_date: "2026-11-13", last: "2026-08-01",
        current: { date: "2026-11-13", files: { slack: "meetings/advisor/2026-11-13_slack.md" }, legacy: false, status: "cancelled" },
        history: [{ date: "2026-08-01", files: { slides: "Alpha/meetings/slides_20260801.md" }, legacy: true, status: "prepared" }] },
      group: { title: "Group meeting", next: Date.UTC(2026, 10, 11, 18), next_date: "2026-11-11", last: null,
        current: { date: "2026-11-11", files: {}, legacy: false, status: "planned" }, history: [] } },
    questions: [{ kind: "advisor", line: 6, raw: "- [ ] Drop the survey?", checked: false, text: "Drop the survey?" }],
    action_items: [{ date: "2026-08-01", items: [{ id: "V-MEET801-2", line: 3, raw: "- [ ] V-MEET801-2 Survey", checked: false, text: "Survey" }] }] };

  it("shows both meetings, prefills prompts, adds a question, shows the Slack update", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url === "/api/meetings" ? json(VIEW) : url.startsWith("/api/file") ? json({ text: "*Progress* hi the advisor" }) : json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const onPrompt = vi.fn();
    render(<Meetings onAsk={() => {}} onPrompt={onPrompt} />);
    expect(await screen.findByText("Group meeting")).toBeTruthy();
    expect(screen.getByText("History · Group meeting")).toBeTruthy();
    expect(await screen.findByText("*Progress* hi the advisor")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Prepare slides" })[0]);
    expect(onPrompt.mock.calls[0][0]).toMatch(/group meeting update for 2026-11-11.*exactly 2 slides.*Speaking notes/);
    fireEvent.click(screen.getByRole("button", { name: "Cancelled → Slack update" }));
    expect(onPrompt.mock.calls[1][0]).toMatch(/2026-11-13_slack\.md/);
    fireEvent.change(screen.getByLabelText("New question"), { target: { value: "Which venue?" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === "/api/meetings/question")).toBe(true));
    expect(screen.getByText("Drop the survey?")).toBeTruthy();
    expect(screen.getByText("V-MEET801-2")).toBeTruthy();
  });

  it("replies to one action item with its line attached", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/meetings" ? json(VIEW) : json({ text: "" })));
    const onReply = vi.fn();
    render(<Meetings onAsk={() => {}} onPrompt={() => {}} onReply={onReply} />);
    await screen.findByText("V-MEET801-2");
    fireEvent.doubleClick(screen.getByText("Survey"));
    fireEvent.change(screen.getByLabelText("Reply to this item"), { target: { value: "done, mark it" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
    expect(onReply.mock.calls[0][0]).toBe("Action item V-MEET801-2");
    expect(onReply.mock.calls[0][1]).toContain("- [ ] V-MEET801-2 Survey");
    expect(onReply.mock.calls[0][2]).toBe("done, mark it");
    await new Promise((r) => setTimeout(r, 300)); // the double-click must not tick the box
    expect((screen.getAllByRole("checkbox") as HTMLInputElement[]).every((c) => !c.checked)).toBe(true);
  });
});

describe("meeting prompts", () => {
  it("action item ids use M+DD", () => {
    expect(PROMPTS.notes("advisor", "2026-11-13")).toContain("<P>-MEET1113-N");
    expect(PROMPTS.notes("group", "2026-08-05")).toContain("<P>-MEET805-N");
  });
});

describe("Literature settings", () => {
  it("adds a keyword group and saves the radar config", async () => {
    const { Literature } = await import("./Literature");
    const CFG = { keyword_groups: [{ id: "core", query: "sleep technology intervention", project: "all" }],
      tracked_authors: [{ name: "Juho Kim", id: "1800981", tier: "A" }], venues: { tier1: ["CHI"], tier2: ["UIST"] },
      areas: ["HCI"], lookback_days: 7, projects: ["all", "cross", "Alpha"], tiers: ["S", "A", "B", "self"] };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/literature/config") return json(init?.method === "POST" ? JSON.parse(String(init.body)).config : CFG);
      return json({ digests: [], digest: null, intro: "", groups: [], notes: [], reading_log: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Literature onAsk={() => undefined} onPrompt={() => undefined} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Settings" }));
    expect(await screen.findByDisplayValue("sleep technology intervention")).toBeTruthy();
    fireEvent.click(screen.getByText("+ Add keyword group"));
    const queries = screen.getAllByPlaceholderText("search words");
    fireEvent.change(queries[1], { target: { value: "social story generative AI" } });
    fireEvent.click(screen.getByText("Save settings"));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => u === "/api/literature/config" && i?.method === "POST")).toBe(true));
    const body = JSON.parse(String(fetchMock.mock.calls.find(([u, i]) => u === "/api/literature/config" && i?.method === "POST")![1]!.body));
    expect(body.config.keyword_groups[1]).toEqual({ id: "", query: "social story generative AI", project: "all" });
    expect(body.config.tracked_authors[0].id).toBe("1800981");
  });
});

describe("Trends save for later", () => {
  it("stars an item, lists it under Saved, and unstars it", async () => {
    const item = { id: "a", title: "Embodied plans", url: "https://arxiv.org/abs/1", source: "arXiv cs.AI", kind: "academic", published: null,
      snippet: "", topics: [], zh: "Key point", relevance: 2, why: "PRR" };
    let saved: unknown[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/trends/saved") {
        const b = JSON.parse(String(init!.body));
        saved = b.saved ? [{ ...b.item, day: b.day, saved_at: 1 }] : [];
        return json({ saved });
      }
      return json({ days: ["2026-11-10"], day: "2026-11-10", config: null, items: [item], headline: null, errors: [], generated: 1, summarized: true, saved });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Trends onAsk={() => undefined} onPrompt={() => undefined} />);
    expect(await screen.findByText("Relevant")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save for later" }));
    expect(await screen.findByRole("button", { name: "Saved — tap to remove" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /★ Saved 1/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /★ Saved 1/ }));
    expect(await screen.findByText(/from 2026-11-10/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Saved — tap to remove" }));
    expect(await screen.findByText(/Nothing saved yet/)).toBeTruthy();
  });
});
