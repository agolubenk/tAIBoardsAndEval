import { describe, expect, it } from "vite-plus/test";
import {
  scopedKeyMayCall,
  scopedKeyMayCallAuth,
} from "./scoped-api-key-routes";

describe("scopedKeyMayCall", () => {
  it("allows routes that resolve their workspace", () => {
    for (const [method, path] of [
      ["GET", "/api/project"],
      ["POST", "/api/task/abc"],
      ["GET", "/api/task/by-ticket-id/TB-1"],
      ["POST", "/api/task-relation"],
      ["GET", "/api/forest/ws-a/trees"],
      ["POST", "/api/notebook/ws-a/search"],
      ["GET", "/api/workspace/"],
      ["GET", "/api/user/me"],
    ] as const) {
      expect(scopedKeyMayCall(method, path), `${method} ${path}`).toBe(true);
    }
  });

  it("refuses routes that span workspaces or manage the account", () => {
    for (const [method, path] of [
      ["GET", "/api/notification"],
      ["PUT", "/api/notification/read-all"],
      ["GET", "/api/notification-preferences"],
      ["GET", "/api/invitation"],
      ["GET", "/api/admin/users"],
      ["POST", "/api/user/avatar"],
      ["GET", "/api/ws/user"],
      ["GET", "/api/integration-sync/status"],
      ["GET", "/api/oauth/authorize"],
      ["GET", "/api/projects"],
      ["GET", "/api/tasks-export"],
    ] as const) {
      expect(scopedKeyMayCall(method, path), `${method} ${path}`).toBe(false);
    }
  });
});

describe("scopedKeyMayCallAuth", () => {
  it("allows reading the session and the workspace list", () => {
    expect(scopedKeyMayCallAuth("GET", "/api/auth/get-session")).toBe(true);
    expect(scopedKeyMayCallAuth("get", "/api/auth/organization/list/")).toBe(
      true,
    );
  });

  it("refuses minting, widening or deleting keys and workspaces", () => {
    for (const [method, path] of [
      ["POST", "/api/auth/api-key/create"],
      ["POST", "/api/auth/api-key/update"],
      ["GET", "/api/auth/api-key/list"],
      ["POST", "/api/auth/organization/set-active"],
      ["POST", "/api/auth/organization/create"],
      ["POST", "/api/auth/organization/delete"],
      ["POST", "/api/auth/organization/list"],
    ] as const) {
      expect(scopedKeyMayCallAuth(method, path), `${method} ${path}`).toBe(
        false,
      );
    }
  });
});
