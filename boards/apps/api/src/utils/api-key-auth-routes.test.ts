import { describe, expect, it } from "vite-plus/test";
import {
  apiKeyMayCallAuth,
  assertApiKeyAuthRoute,
} from "./api-key-auth-routes";

describe("apiKeyMayCallAuth", () => {
  it("allows reading the session and the workspace list", () => {
    expect(apiKeyMayCallAuth("GET", "/api/auth/get-session")).toBe(true);
    expect(apiKeyMayCallAuth("get", "/api/auth/organization/list/")).toBe(true);
  });

  it("refuses managing the account, its keys, sessions and workspaces", () => {
    for (const [method, path] of [
      ["POST", "/api/auth/delete-user"],
      ["GET", "/api/auth/delete-user/callback"],
      ["POST", "/api/auth/api-key/create"],
      ["POST", "/api/auth/api-key/update"],
      ["GET", "/api/auth/api-key/list"],
      ["POST", "/api/auth/revoke-sessions"],
      ["POST", "/api/auth/revoke-other-sessions"],
      ["POST", "/api/auth/change-email"],
      ["POST", "/api/auth/change-password"],
      ["POST", "/api/auth/update-user"],
      ["POST", "/api/auth/organization/set-active"],
      ["POST", "/api/auth/organization/create"],
      ["POST", "/api/auth/organization/delete"],
      ["POST", "/api/auth/organization/list"],
      ["HEAD", "/api/auth/get-session"],
      ["GET", "/api/auth//get-session"],
    ] as const) {
      expect(apiKeyMayCallAuth(method, path), `${method} ${path}`).toBe(false);
    }
  });
});

describe("assertApiKeyAuthRoute", () => {
  it("refuses with SESSION_REQUIRED", () => {
    expect(() =>
      assertApiKeyAuthRoute("POST", "/api/auth/delete-user"),
    ).toThrowError(
      expect.objectContaining({ status: 403, code: "SESSION_REQUIRED" }),
    );
    expect(() =>
      assertApiKeyAuthRoute("GET", "/api/auth/get-session"),
    ).not.toThrow();
  });
});
