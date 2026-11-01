import { describe, expect, it } from "vite-plus/test";
import {
  isWorkspaceScoped,
  parseApiKeyWorkspaceScope,
  scopeAllowsWorkspace,
} from "./api-key-workspace-scope";

describe("parseApiKeyWorkspaceScope", () => {
  it("keeps the user's reach without a workspaceId", () => {
    for (const metadata of [null, undefined, "null", "{}", '{"note":"ci"}']) {
      expect(parseApiKeyWorkspaceScope(metadata)).toEqual({ kind: "all" });
    }
  });

  it("reads the workspace from stored and double-stringified metadata", () => {
    const stored = JSON.stringify({ workspaceId: "ws-a" });
    expect(parseApiKeyWorkspaceScope(stored)).toEqual({
      kind: "workspace",
      workspaceId: "ws-a",
    });
    expect(parseApiKeyWorkspaceScope(JSON.stringify(stored))).toEqual({
      kind: "workspace",
      workspaceId: "ws-a",
    });
    expect(parseApiKeyWorkspaceScope({ workspaceId: "ws-a" })).toEqual({
      kind: "workspace",
      workspaceId: "ws-a",
    });
  });

  it("fails closed on unreadable metadata or a bad workspaceId", () => {
    for (const metadata of [
      "{not json",
      "[]",
      "42",
      '{"workspaceId":""}',
      '{"workspaceId":"  "}',
      '{"workspaceId":7}',
      '{"workspaceId":null}',
      '{"workspaceId":["ws-a"]}',
    ]) {
      expect(parseApiKeyWorkspaceScope(metadata)).toEqual({ kind: "invalid" });
    }
  });
});

describe("scopeAllowsWorkspace", () => {
  it("lets unscoped keys and sessions through", () => {
    expect(scopeAllowsWorkspace(undefined, "ws-b")).toBe(true);
    expect(scopeAllowsWorkspace({ kind: "all" }, "ws-b")).toBe(true);
  });

  it("limits a scoped key to its workspace (AC-011)", () => {
    const scope = { kind: "workspace", workspaceId: "ws-a" } as const;
    expect(scopeAllowsWorkspace(scope, "ws-a")).toBe(true);
    expect(scopeAllowsWorkspace(scope, "ws-b")).toBe(false);
    expect(isWorkspaceScoped(scope)).toBe(true);
  });

  it("lets an invalid scope reach nothing", () => {
    expect(scopeAllowsWorkspace({ kind: "invalid" }, "ws-a")).toBe(false);
    expect(scopeAllowsWorkspace({ kind: "invalid" }, "")).toBe(false);
    expect(isWorkspaceScoped({ kind: "invalid" })).toBe(true);
  });
});
