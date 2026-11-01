import { ForestError } from "../forest/forest-error";
import { apiKeyMayCallAuth } from "../utils/api-key-auth-routes";

// An agent key gets the same /auth allowlist as every key — who it is and
// which workspaces it sees — but its refusal names the agent rule, so a
// session can tell an agent limit from a missing sign-in.
export function assertAgentAuthRoute(
  agent: { name: string } | null | undefined,
  method: string,
  path: string,
): void {
  if (!agent) return;
  if (apiKeyMayCallAuth(method, path)) return;
  throw new ForestError(
    "agent_forbidden",
    "agent keys only read their session and workspaces on /auth; the owner manages keys and accounts",
  );
}
