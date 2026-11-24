// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Automation } from "./Automation";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const job = (name: string, title: string, status: string, extra = {}) => ({
  name, title, status, schedule: "daily 07:00 local", next_run: 1794300000000, running: false,
  last_start: 1794200000000, last_end: 1794200100000, rc: status === "failed" ? 1 : 0, last_ok: 1794200100000,
  reason: "scheduled", log_tail: "Not logged in", output: "", requested: false, ...extra,
});
const snap = {
  jobs: [job("daily_check", "Daily check", "failed"), job("weekly_radar", "Literature radar", "ok")],
  nextcloud: { status: "ok", last_ok: 1794200000000 },
  conflicts: ["Alpha/a (conflicted copy).md"],
  mac_jobs: [{ title: "Zotero reading log", schedule: "daily (Mac)", last_activity: null, log_tail: "", status: "never" }],
};

describe("Automation", () => {
  it("shows job statuses, conflicts, and queues a run", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST" ? new Response(JSON.stringify({ requested: "daily_check" })) : new Response(JSON.stringify(snap)));
    vi.stubGlobal("fetch", fetchMock);
    render(<Automation />);
    const daily = await screen.findByLabelText("Daily check");
    expect(within(daily).getByText("Failed")).toBeTruthy();
    expect(within(screen.getByLabelText("Literature radar")).getByText("OK")).toBeTruthy();
    expect(screen.getByText("Alpha/a (conflicted copy).md")).toBeTruthy();
    expect(screen.getByText("Never run")).toBeTruthy();
    await act(async () => { fireEvent.click(within(daily).getByText("Run now")); });
    expect(fetchMock).toHaveBeenCalledWith("/api/automation/run/daily_check", { method: "POST" });
    expect(screen.getByRole("status").textContent).toContain("queued");
  });
});
