// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Brain } from "./Brain";

afterEach(cleanup);

describe("Brain", () => {
  it("embeds the map page with nothing around it", () => {
    const { container } = render(<Brain />);
    expect(container.children).toHaveLength(1);
    expect(container.querySelector("iframe")!.getAttribute("src")).toBe("/brain/index.html");
  });
});
