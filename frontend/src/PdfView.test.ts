import { describe, expect, it } from "vitest";
import { canvasScale } from "./PdfView";

describe("canvasScale", () => {
  it("uses the device pixel ratio when the canvas fits the budget", () => {
    expect(canvasScale(400, 520, 3, 8_000_000)).toBe(3);
  });
  it("lowers the scale so a zoomed page stays under the pixel budget (iPhone, DPR 3, zoom 3, full screen)", () => {
    const w = 820 * 3, h = w * 1.294; // landscape full-screen width at 300 %, Letter aspect
    const s = canvasScale(w, h, 3, 8_000_000);
    expect(s).toBeLessThan(3);
    expect(Math.floor(w * s) * Math.floor(h * s)).toBeLessThanOrEqual(8_000_000);
  });
  it("never exceeds the device pixel ratio and handles dpr 0", () => {
    expect(canvasScale(10, 10, 1, 16_000_000)).toBe(1);
    expect(canvasScale(10, 10, 0, 16_000_000)).toBe(1);
  });
});
