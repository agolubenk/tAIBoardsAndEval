import { ForestError } from "../forest/forest-error";

// What an agent key may ask of Better Auth: who it is and which workspaces it
// sees. Everything else there — new keys, a new name or email, sessions —
// would let an agent outgrow the identity its owner gave it.
const AGENT_AUTH_ROUTES = new Set([
  "GET /api/auth/get-session",
  "GET /api/auth/organization/list",
]);

export function assertAgentAuthRoute(
  agent: { name: string } | null | undefined,
  method: string,
  path: string,
): void {
  if (!agent) return;
  const normalized = path.replace(/\/+$/, "");
  if (AGENT_AUTH_ROUTES.has(`${method.toUpperCase()} ${normalized}`)) return;
  throw new ForestError(
    "agent_forbidden",
    "agent keys only read their session and workspaces on /auth; the owner manages keys and accounts",
  );
}
