// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { navigate, parseHash, routeHash } from "./route";

describe("hash routes", () => {
  it("round-trips panel + sub-path, including slashes and spaces inside a segment", () => {
    const h = routeHash("today", ["~file", "Alpha/a b.md", "x"]);
    expect(h).toBe("#/today/~file/Alpha%2Fa%20b.md/x");
    expect(parseHash(h)).toEqual({ panel: "today", rest: ["~file", "Alpha/a b.md", "x"] });
  });
  it("handles empty and malformed hashes", () => {
    expect(parseHash("")).toEqual({ panel: "", rest: [] });
    expect(parseHash("#/reading/%E0%A4%A")).toEqual({ panel: "reading", rest: ["%E0%A4%A"] });
  });
  it("navigate pushes, replace swaps the entry", () => {
    navigate("reading", ["arxiv-1"]);
    expect(window.location.hash).toBe("#/reading/arxiv-1");
    const n = window.history.length;
    navigate("reading", [], true);
    expect(window.location.hash).toBe("#/reading");
    expect(window.history.length).toBe(n);
  });
});
