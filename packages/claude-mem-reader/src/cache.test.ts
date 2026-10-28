import { describe, expect, it, vi } from "vite-plus/test";
import { createMemoryCacheStore, withCache } from "./cache.js";
import {
  ClaudeMemHttpError,
  ClaudeMemUnavailableError,
  type ClaudeMemReader,
} from "./client.js";
import type {
  Observation,
  Page,
  ProjectsCatalog,
  WorkerHealth,
} from "./types.js";

const HEALTH: WorkerHealth = { status: "ok" };
const PROJECTS: ProjectsCatalog = {
  projects: ["alpha"],
  sources: ["claude"],
  projectsBySource: { claude: ["alpha"] },
};

function stubReader(overrides: Partial<ClaudeMemReader> = {}): ClaudeMemReader {
  return {
    health: vi.fn(async () => HEALTH),
    listProjects: vi.fn(async () => PROJECTS),
    listObservations: vi.fn(async (): Promise<Page<Observation>> => ({
      items: [],
      hasMore: false,
      offset: 0,
      limit: 50,
    })),
    getObservation: vi.fn(),
    ...overrides,
  };
}

describe("withCache", () => {
  it("returns fresh data and stamps it with the injected clock", async () => {
    let now = 1000;
    const cached = withCache(stubReader(), { clock: () => now });

    const result = await cached.health();

    expect(result.stale).toBe(false);
    expect(result.fetchedAt).toBe(1000);
    expect(result.data).toBe(HEALTH);
    expect(result.error).toBeUndefined();
  });

  it("serves the cached copy with its original timestamp when the worker is down", async () => {
    let now = 1000;
    const reader = stubReader();
    const cached = withCache(reader, { clock: () => now });

    await cached.listProjects();
    now = 2000;
    reader.listProjects = vi.fn(async () => {
      throw new ClaudeMemUnavailableError(
        "claude-mem worker unreachable: ECONNREFUSED",
      );
    });

    const result = await cached.listProjects();

    expect(result.stale).toBe(true);
    expect(result.fetchedAt).toBe(1000);
    expect(result.data).toBe(PROJECTS);
    expect(result.error).toBeInstanceOf(ClaudeMemUnavailableError);
  });

  it("falls back on 5xx but rethrows 4xx even when a cache entry exists", async () => {
    const reader = stubReader();
    const cached = withCache(reader);

    await cached.listProjects();

    reader.listProjects = vi.fn(async () => {
      throw new ClaudeMemHttpError("HTTP 500", 500, null);
    });
    const degraded = await cached.listProjects();
    expect(degraded.stale).toBe(true);

    reader.listProjects = vi.fn(async () => {
      throw new ClaudeMemHttpError("HTTP 400", 400, null);
    });
    await expect(cached.listProjects()).rejects.toBeInstanceOf(
      ClaudeMemHttpError,
    );
  });

  it("rethrows when the worker is down and nothing is cached", async () => {
    const reader = stubReader({
      health: vi.fn(async () => {
        throw new ClaudeMemUnavailableError("down");
      }),
    });
    const cached = withCache(reader);

    await expect(cached.health()).rejects.toBeInstanceOf(
      ClaudeMemUnavailableError,
    );
  });

  it("caches per method and per params", async () => {
    const reader = stubReader();
    const cached = withCache(reader);

    await cached.listObservations({ project: "alpha" });
    await cached.listObservations({ project: "beta" });

    reader.listObservations = vi.fn(async () => {
      throw new ClaudeMemUnavailableError("down");
    });

    const alpha = await cached.listObservations({ project: "alpha" });
    expect(alpha.stale).toBe(true);
    await expect(
      cached.listObservations({ project: "gamma" }),
    ).rejects.toBeInstanceOf(ClaudeMemUnavailableError);
  });

  it("treats param order as the same cache key", async () => {
    const reader = stubReader();
    const store = createMemoryCacheStore();
    const writes: string[] = [];
    const spyStore = {
      get: (key: string) => store.get(key),
      set: (key: string, entry: { value: unknown; fetchedAt: number }) => {
        writes.push(key);
        store.set(key, entry);
      },
    };
    const cached = withCache(reader, { store: spyStore });

    await cached.listObservations({ project: "alpha", limit: 10 });
    await cached.listObservations({ limit: 10, project: "alpha" });

    expect(writes).toEqual([
      'observations:{"limit":10,"project":"alpha"}',
      'observations:{"limit":10,"project":"alpha"}',
    ]);
  });

  it("recovers to fresh data once the worker answers again", async () => {
    let now = 1000;
    const reader = stubReader();
    const cached = withCache(reader, { clock: () => now });

    await cached.health();
    now = 2000;
    reader.health = vi.fn(async () => {
      throw new ClaudeMemUnavailableError("down");
    });
    await cached.health();

    now = 3000;
    const recovered: WorkerHealth = { status: "ok", uptime: 5 };
    reader.health = vi.fn(async () => recovered);
    const result = await cached.health();

    expect(result.stale).toBe(false);
    expect(result.fetchedAt).toBe(3000);
    expect(result.data).toBe(recovered);
  });
});
