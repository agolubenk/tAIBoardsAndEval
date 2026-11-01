import { describe, expect, it, vi } from "vitest";
import {
  ClaudeMemHttpError,
  ClaudeMemUnavailableError,
  createClaudeMemReader,
} from "./client.js";
import type { FetchLike } from "./types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const WIRE_OBSERVATION = {
  id: 101,
  memory_session_id: "mem-session-1",
  content_session_id: "session-1",
  project: "synthetic-project",
  merged_into_project: null,
  platform_source: "claude",
  type: "bugfix",
  title: "Synthetic observation title",
  subtitle: "Synthetic subtitle",
  narrative: "Synthetic narrative text.",
  text: null,
  facts: '["fact one","fact two"]',
  concepts: '["problem-solution"]',
  files_read: '["/tmp/synthetic/a.ts"]',
  files_modified: "[]",
  prompt_number: 3,
  created_at: "2026-01-01T00:00:00.000Z",
  created_at_epoch: 1767225600000,
};

describe("createClaudeMemReader", () => {
  it("calls GET /api/health and parses the status", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      jsonResponse({ status: "ok", version: "0.0.0-test" }),
    );
    const reader = createClaudeMemReader({
      baseUrl: "http://127.0.0.1:3777",
      fetch: fetchImpl,
    });

    const health = await reader.health();

    expect(health.status).toBe("ok");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:3777/api/health");
    expect(init?.method ?? "GET").toBe("GET");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("calls GET /api/projects and parses the catalog", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      jsonResponse({
        projects: ["alpha", "beta"],
        sources: ["claude"],
        projectsBySource: { claude: ["alpha", "beta"] },
      }),
    );
    const reader = createClaudeMemReader({
      baseUrl: "http://127.0.0.1:3777",
      fetch: fetchImpl,
    });

    const catalog = await reader.listProjects();

    expect(catalog.projects).toEqual(["alpha", "beta"]);
    expect(catalog.projectsBySource.claude).toEqual(["alpha", "beta"]);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "http://127.0.0.1:3777/api/projects",
    );
  });

  it("serializes listObservations params and parses wire fields", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      jsonResponse({
        items: [WIRE_OBSERVATION],
        hasMore: true,
        offset: 20,
        limit: 10,
      }),
    );
    const reader = createClaudeMemReader({
      baseUrl: "http://127.0.0.1:3777/",
      fetch: fetchImpl,
    });

    const page = await reader.listObservations({
      project: "synthetic-project",
      platformSource: "claude",
      contentSessionId: "session-1",
      limit: 10,
      offset: 20,
    });

    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url.startsWith("http://127.0.0.1:3777/api/observations?")).toBe(true);
    const query = new URL(url).searchParams;
    expect(query.get("project")).toBe("synthetic-project");
    expect(query.get("platformSource")).toBe("claude");
    expect(query.get("contentSessionId")).toBe("session-1");
    expect(query.get("limit")).toBe("10");
    expect(query.get("offset")).toBe("20");

    expect(page.hasMore).toBe(true);
    expect(page.items).toHaveLength(1);
    const observation = page.items[0];
    expect(observation.id).toBe(101);
    expect(observation.facts).toEqual(["fact one", "fact two"]);
    expect(observation.concepts).toEqual(["problem-solution"]);
    expect(observation.filesRead).toEqual(["/tmp/synthetic/a.ts"]);
    expect(observation.filesModified).toEqual([]);
    expect(observation.createdAtEpoch).toBe(1767225600000);
  });

  it("tolerates malformed JSON-string list fields", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      jsonResponse({
        items: [{ ...WIRE_OBSERVATION, facts: "{broken", concepts: null }],
        hasMore: false,
        offset: 0,
        limit: 50,
      }),
    );
    const reader = createClaudeMemReader({
      baseUrl: "http://127.0.0.1:3777",
      fetch: fetchImpl,
    });

    const page = await reader.listObservations();

    expect(page.items[0].facts).toEqual([]);
    expect(page.items[0].concepts).toEqual([]);
  });

  it("parses metadata on GET /api/observation/:id", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      jsonResponse({
        ...WIRE_OBSERVATION,
        metadata: '{"branch":"feat/synthetic","task_id":"TB-7"}',
      }),
    );
    const reader = createClaudeMemReader({
      baseUrl: "http://127.0.0.1:3777",
      fetch: fetchImpl,
    });

    const detail = await reader.getObservation(101);

    expect(fetchImpl.mock.calls[0][0]).toBe(
      "http://127.0.0.1:3777/api/observation/101",
    );
    expect(detail.metadata).toEqual({ branch: "feat/synthetic", task_id: "TB-7" });
  });

  it("keeps metadata null when the worker sends null", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      jsonResponse({ ...WIRE_OBSERVATION, metadata: null }),
    );
    const reader = createClaudeMemReader({
      baseUrl: "http://127.0.0.1:3777",
      fetch: fetchImpl,
    });

    const detail = await reader.getObservation(101);

    expect(detail.metadata).toBeNull();
  });

  it("rejects a non-positive observation id without fetching", async () => {
    const fetchImpl = vi.fn<FetchLike>();
    const reader = createClaudeMemReader({
      baseUrl: "http://127.0.0.1:3777",
      fetch: fetchImpl,
    });

    await expect(reader.getObservation(0)).rejects.toBeInstanceOf(TypeError);
    await expect(reader.getObservation(-3)).rejects.toBeInstanceOf(TypeError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws ClaudeMemHttpError with status and body on non-2xx", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      jsonResponse({ error: "not found" }, 404),
    );
    const reader = createClaudeMemReader({
      baseUrl: "http://127.0.0.1:3777",
      fetch: fetchImpl,
    });

    const error = await reader.getObservation(999).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ClaudeMemHttpError);
    expect((error as ClaudeMemHttpError).status).toBe(404);
    expect((error as ClaudeMemHttpError).body).toEqual({ error: "not found" });
  });

  it("wraps network failures in ClaudeMemUnavailableError", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    });
    const reader = createClaudeMemReader({
      baseUrl: "http://127.0.0.1:3777",
      fetch: fetchImpl,
    });

    const error = await reader.health().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ClaudeMemUnavailableError);
    expect((error as Error).message).toContain("ECONNREFUSED");
  });

  it("never sends a body: every request is a plain GET", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse({}));
    const reader = createClaudeMemReader({
      baseUrl: "http://127.0.0.1:3777",
      fetch: fetchImpl,
    });

    await reader.health().catch(() => undefined);
    await reader.listProjects().catch(() => undefined);
    await reader.listObservations().catch(() => undefined);
    await reader.getObservation(1).catch(() => undefined);

    for (const [, init] of fetchImpl.mock.calls) {
      expect(init?.method ?? "GET").toBe("GET");
      expect(init?.body).toBeUndefined();
    }
  });
});
