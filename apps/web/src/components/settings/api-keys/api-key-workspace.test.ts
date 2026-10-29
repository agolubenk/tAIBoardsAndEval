import { describe, expect, it } from "vite-plus/test";
import {
  ALL_WORKSPACES,
  apiKeyWorkspaceMetadata,
  readApiKeyWorkspace,
} from "./api-key-workspace";

describe("apiKeyWorkspaceMetadata", () => {
  it("sends no metadata for an all-workspaces key", () => {
    expect(apiKeyWorkspaceMetadata(ALL_WORKSPACES)).toBeUndefined();
    expect(apiKeyWorkspaceMetadata("ws-a")).toEqual({ workspaceId: "ws-a" });
  });
});

describe("readApiKeyWorkspace", () => {
  it("returns null for a key without a workspace", () => {
    for (const metadata of [null, undefined, "null", {}, '{"note":"ci"}']) {
      expect(readApiKeyWorkspace(metadata)).toBeNull();
    }
  });

  it("reads parsed, stored and double-encoded metadata", () => {
    const stored = JSON.stringify({ workspaceId: "ws-a" });
    expect(readApiKeyWorkspace({ workspaceId: "ws-a" })).toBe("ws-a");
    expect(readApiKeyWorkspace(stored)).toBe("ws-a");
    expect(readApiKeyWorkspace(JSON.stringify(stored))).toBe("ws-a");
  });

  it("marks unreadable metadata as scoped to an unknown workspace", () => {
    for (const metadata of ["{oops", "[]", '{"workspaceId":7}']) {
      expect(readApiKeyWorkspace(metadata)).toBe("");
    }
  });
});
