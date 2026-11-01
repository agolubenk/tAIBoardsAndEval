import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  isWorkerOnline,
  leaseChunks,
  leasedChunkIds,
  markWorkerSeen,
  releaseChunks,
  requestQueryEmbedding,
  resetEmbedQueueForTests,
  resolveQuery,
  takeQueries,
  WORKER_ONLINE_MS,
  waitForEmbedWork,
} from "./embed-queue";

afterEach(() => {
  resetEmbedQueueForTests();
  vi.useRealTimers();
});

describe("embed queue", () => {
  it("hands a query to the worker once and resolves it with the vector", async () => {
    const pending = requestQueryEmbedding("ws1", "как устроен лес", 1_000);
    const [taken] = takeQueries("ws1", 8);
    expect(taken?.text).toBe("как устроен лес");
    expect(takeQueries("ws1", 8)).toEqual([]);
    expect(resolveQuery("ws2", taken?.id ?? "", Buffer.alloc(4))).toBe(false);
    expect(resolveQuery("ws1", taken?.id ?? "", Buffer.alloc(8))).toBe(true);
    expect((await pending)?.length).toBe(8);
    expect(resolveQuery("ws1", taken?.id ?? "", Buffer.alloc(8))).toBe(false);
  });

  it("gives up on a query the worker never answers", async () => {
    vi.useFakeTimers();
    const pending = requestQueryEmbedding("ws1", "q", 4_000);
    vi.advanceTimersByTime(4_000);
    expect(await pending).toBeNull();
    expect(takeQueries("ws1", 8)).toEqual([]);
  });

  it("wakes a parked worker when work arrives and counts it online", async () => {
    const parked = waitForEmbedWork("ws1", 25_000);
    expect(isWorkerOnline("ws1")).toBe(true);
    expect(isWorkerOnline("ws2")).toBe(false);
    void requestQueryEmbedding("ws1", "q", 1_000);
    await parked;
    expect(isWorkerOnline("ws1")).toBe(false);
  });

  it("forgets a worker that stopped polling", () => {
    markWorkerSeen("ws1", 1_000);
    expect(isWorkerOnline("ws1", 1_000 + WORKER_ONLINE_MS - 1)).toBe(true);
    expect(isWorkerOnline("ws1", 1_000 + WORKER_ONLINE_MS)).toBe(false);
  });

  it("skips leased chunks until they come back or the lease runs out", () => {
    leaseChunks("ws1", ["a", "b"], 0);
    expect(leasedChunkIds("ws1", 1)).toEqual(["a", "b"]);
    releaseChunks("ws1", ["a"]);
    expect(leasedChunkIds("ws1", 1)).toEqual(["b"]);
    expect(leasedChunkIds("ws1", 60_000)).toEqual([]);
  });
});
