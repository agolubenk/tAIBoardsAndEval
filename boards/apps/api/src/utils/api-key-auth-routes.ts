import { ApiError } from "../errors/api-error";

// t-boards (TB-119 S-1(в)): what any API key may ask of Better Auth — who it is
// and which workspaces it sees. The api-key plugin builds the key's session in
// memory with createdAt = now, so it is always "fresh": delete-user without a
// password, new keys, revoked sessions and email changes would all pass on a
// leaked key. Account and key management stays behind a signed-in session.
const API_KEY_AUTH_ROUTES = new Set([
  "GET /api/auth/get-session",
  "GET /api/auth/organization/list",
]);

export function apiKeyMayCallAuth(method: string, path: string): boolean {
  const normalized = path.replace(/\/+$/, "");
  return API_KEY_AUTH_ROUTES.has(`${method.toUpperCase()} ${normalized}`);
}

export function assertApiKeyAuthRoute(method: string, path: string): void {
  if (apiKeyMayCallAuth(method, path)) return;
  throw new ApiError(403, {
    message: "A user session is required",
    code: "SESSION_REQUIRED",
  });
}
