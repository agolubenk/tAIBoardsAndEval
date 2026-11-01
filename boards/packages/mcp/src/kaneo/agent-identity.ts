import { AsyncLocalStorage } from "node:async_hooks";

// R-010: who a tool call works as. One stdio server may serve several sessions
// (a hub shares it), so the identity travels with each call, not the process.
export type AgentIdentity = { harness: string; session?: string };

const current = new AsyncLocalStorage<AgentIdentity>();

export function withAgentIdentity<T>(identity: AgentIdentity, fn: () => T): T {
  return current.run(identity, fn);
}

export function currentAgentIdentity(): AgentIdentity | undefined {
  return current.getStore();
}

// Same slug the API accepts: lowercase, digits, . _ -, up to 40.
export function harnessSlug(raw: string | undefined): string | undefined {
  const slug = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 40)
    .replace(/[-.]+$/, "");
  return slug || undefined;
}

export function identityKey({ harness, session }: AgentIdentity) {
  return `${harness}\n${(session ?? "").trim().toLowerCase()}`;
}
