import { describe, expect, it } from "vite-plus/test";
import { cardWorkerLine } from "./card-worker-line";

const now = Date.parse("2026-10-29T22:00:00.000Z");
const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();

describe("cardWorkerLine", () => {
  it("shows the lease holder first and the executor only when it differs", () => {
    expect(
      cardWorkerLine(
        {
          taskId: "a",
          holder: { name: "backend s-1", kind: "agent", until: hoursAgo(-1) },
          session: {
            name: "qa s-2",
            kind: "agent",
            step: "ревью",
            at: hoursAgo(1),
          },
          executor: "backend s-1",
        },
        now,
      ),
    ).toMatchObject({
      source: "holder",
      name: "backend s-1",
      live: true,
      executor: null,
    });
  });

  it("dims a session that has been silent for half a day", () => {
    const worker = (h: number) => ({
      taskId: "a",
      holder: null,
      session: {
        name: "qa s-2",
        kind: "agent",
        step: "ревью",
        at: hoursAgo(h),
      },
      executor: "ops s-3",
    });
    expect(cardWorkerLine(worker(1), now)).toMatchObject({
      source: "session",
      live: true,
      executor: "ops s-3",
    });
    expect(cardWorkerLine(worker(13), now)?.live).toBe(false);
  });

  it("falls back to the executor and hides cards nobody is on", () => {
    expect(
      cardWorkerLine(
        { taskId: "a", holder: null, session: null, executor: "ops s-3" },
        now,
      ),
    ).toMatchObject({ source: "executor", name: "ops s-3", live: false });
    expect(cardWorkerLine(undefined, now)).toBeNull();
  });
});
