import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKER_HOST,
  DEFAULT_WORKER_PORT,
  resolveWorkerUrl,
} from "./settings.js";

const noFile = () => undefined;

describe("resolveWorkerUrl", () => {
  it("prefers CLAUDE_MEM_WORKER_PORT from env over settings", () => {
    const url = resolveWorkerUrl({
      env: { CLAUDE_MEM_WORKER_PORT: "41000" },
      readFile: () =>
        JSON.stringify({ CLAUDE_MEM_WORKER_PORT: "37701" }),
    });
    expect(url).toBe(`http://${DEFAULT_WORKER_HOST}:41000`);
  });

  it("reads the port from settings.json when env is missing", () => {
    const url = resolveWorkerUrl({
      env: {},
      readFile: () =>
        JSON.stringify({
          CLAUDE_MEM_WORKER_PORT: "37701",
          CLAUDE_MEM_WORKER_HOST: "127.0.0.1",
        }),
    });
    expect(url).toBe("http://127.0.0.1:37701");
  });

  it("falls back to defaults when neither env nor settings exist", () => {
    const url = resolveWorkerUrl({ env: {}, readFile: noFile });
    expect(url).toBe(`http://${DEFAULT_WORKER_HOST}:${DEFAULT_WORKER_PORT}`);
  });

  it("honours a custom settingsPath", () => {
    const seen: string[] = [];
    resolveWorkerUrl({
      env: {},
      settingsPath: "/tmp/synthetic/settings.json",
      readFile: (path) => {
        seen.push(path);
        return undefined;
      },
    });
    expect(seen).toEqual(["/tmp/synthetic/settings.json"]);
  });

  it("treats invalid JSON in settings as absent", () => {
    const url = resolveWorkerUrl({
      env: {},
      readFile: () => "{ not json",
    });
    expect(url).toBe(`http://${DEFAULT_WORKER_HOST}:${DEFAULT_WORKER_PORT}`);
  });

  it("ignores a non-numeric port", () => {
    const url = resolveWorkerUrl({
      env: { CLAUDE_MEM_WORKER_PORT: "abc" },
      readFile: noFile,
    });
    expect(url).toBe(`http://${DEFAULT_WORKER_HOST}:${DEFAULT_WORKER_PORT}`);
  });

  it("ignores out-of-range ports", () => {
    const url = resolveWorkerUrl({
      env: { CLAUDE_MEM_WORKER_PORT: "70000" },
      readFile: noFile,
    });
    expect(url).toBe(`http://${DEFAULT_WORKER_HOST}:${DEFAULT_WORKER_PORT}`);
  });

  it("takes the host from env when set", () => {
    const url = resolveWorkerUrl({
      env: { CLAUDE_MEM_WORKER_HOST: "localhost", CLAUDE_MEM_WORKER_PORT: "3777" },
      readFile: noFile,
    });
    expect(url).toBe("http://localhost:3777");
  });

  it("survives a throwing readFile", () => {
    const url = resolveWorkerUrl({
      env: {},
      readFile: () => {
        throw new Error("disk gone");
      },
    });
    expect(url).toBe(`http://${DEFAULT_WORKER_HOST}:${DEFAULT_WORKER_PORT}`);
  });
});
