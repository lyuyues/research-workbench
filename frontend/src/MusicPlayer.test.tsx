import { describe, expect, it } from "vitest";
import { fmt } from "./MusicPlayer";

describe("fmt", () => {
  it("formats seconds", () => {
    expect(fmt(65)).toBe("1:05");
    expect(fmt(7828.9)).toBe("2:10:28");
    expect(fmt(NaN)).toBe("0:00");
  });
});
