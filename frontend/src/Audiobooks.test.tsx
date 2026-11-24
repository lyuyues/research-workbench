// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Audiobooks } from "./Audiobooks";
import { AudioDock, AudioProvider } from "./AudioDock";

// The player is the app-level dock now (keeps playing across panels); render both like App does.
const withDock = () => <AudioProvider><Audiobooks /><AudioDock /></AudioProvider>;

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const data = {
  feeds: { books: "https://h/podcast/T/feed.xml", research: "https://h/podcast/R/feed.xml" },
  books: [
    { slug: "b", title: "Market Signaling", author: "Michael Spence", feed: "books", lang: "zh", added: "2026-11-16",
      episodes: 16, ready: 16, hours: 3.8, complete: true, feed_url: "https://h/podcast/T/book/b.xml",
      chapters: [{ n: 1, title: "Preface", file: "001.mp3", duration: 762, ready: true }, { n: 2, title: "Chapter 1 Introduction", file: "002.mp3", duration: 511, ready: true }] },
    { slug: "papers", title: "Paper briefs", author: "", feed: "research", lang: "en", added: "2026-11-16",
      episodes: 2, ready: 1, hours: 0.1, complete: false, feed_url: "https://h/podcast/R/book/papers.xml",
      chapters: [{ n: 1, title: "Lilo", file: "001.mp3", duration: 455, ready: true }, { n: 2, title: "X", file: "002.mp3", duration: 0, ready: false }] },
  ],
};

const posts: unknown[] = [];
function fetchMock() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/audiobooks/progress" && init?.method === "POST") { posts.push(JSON.parse(String(init.body))); return new Response("{}"); }
    if (url === "/api/audiobooks/progress") return new Response(JSON.stringify({ b: { file: "002.mp3", pos: 75, updated: "x" } }));
    return new Response(JSON.stringify(data));
  });
}

describe("Audiobooks", () => {
  it("continues where you stopped and lists episodes", async () => {
    vi.stubGlobal("fetch", fetchMock());
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => {});
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const { container } = render(withDock());
    fireEvent.click(await screen.findByRole("button", { name: "▶ Continue · 2 (1:15)" }));
    const audio = container.querySelector("audio")!;
    expect(audio.getAttribute("src")).toBe("/api/audiobooks/file/b/002.mp3");
    expect(screen.getAllByText(/Chapter 1 Introduction/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole("button", { name: "Episodes" })[0]);
    fireEvent.click(screen.getByRole("button", { name: /Preface/ }));
    expect(container.querySelector("audio")!.getAttribute("src")).toBe("/api/audiobooks/file/b/001.mp3");
    fireEvent.pause(container.querySelector("audio")!);
    expect(posts[posts.length - 1]).toMatchObject({ slug: "b", file: "001.mp3" });
    expect((screen.getAllByRole("button", { name: "Episodes" }).length)).toBe(1); // research book still closed
    expect(screen.getByRole("button", { name: "Hide episodes" })).toBeTruthy();
  });

  it("lists books per feed and copies a per-book link", async () => {
    vi.stubGlobal("fetch", fetchMock());
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<Audiobooks />);
    expect(await screen.findByText("Market Signaling")).toBeTruthy();
    expect(screen.getByText(/Michael Spence · 16 episodes · 3.8 h/)).toBeTruthy();
    expect(screen.getByText(/converting 1\/2/)).toBeTruthy();
    const buttons = screen.getAllByRole("button", { name: "Copy link" });
    expect(buttons.length).toBe(4); // 2 all-in-one + 2 books
    fireEvent.click(buttons[2]);
    await screen.findByText("Copied ✓");
    expect(writeText).toHaveBeenCalledWith("https://h/podcast/T/book/b.xml");
  });
  it("falls back to a selectable URL when the clipboard is blocked", async () => {
    vi.stubGlobal("fetch", fetchMock());
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => { throw new Error("no"); } }, configurable: true });
    render(<Audiobooks />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Copy link" }))[0]);
    expect(((await screen.findByLabelText("Feed URL")) as HTMLInputElement).value).toBe("https://h/podcast/T/feed.xml");
  });
});
