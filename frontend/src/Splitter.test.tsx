import { describe, expect, it } from "vitest";
import { clampWidths } from "./Splitter";

describe("clampWidths", () => {
  it("keeps widths inside limits and leaves room for the centre", () => {
    expect(clampWidths({ nav: 50, agent: 100 }, 1400)).toEqual({ nav: 120, agent: 260 });
    expect(clampWidths({ nav: 900, agent: 380 }, 1400)).toEqual({ nav: 420, agent: 380 });
    expect(clampWidths({ nav: 180, agent: 2000 }, 1400)).toEqual({ nav: 180, agent: 1400 - 180 - 360 });
  });
});
