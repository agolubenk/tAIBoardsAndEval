import { z } from "zod";
import type { ToolClient } from "../register.js";

export const id = z.string().trim().min(1);

export const sessionField = z
  .string()
  .trim()
  .regex(/^[\p{L}\p{N} ._:/#-]{1,80}$/u, "Letters, digits and ._:/#- only")
  .describe(
    "This agent session's stable label (e.g. role and number). Leases and the journal tell sessions apart by it.",
  );

// Forest calls carry the session label so the API can tell two sessions of
// one key apart (R-026).
export function forestCall(
  client: ToolClient,
  workspaceId: string,
  path: string,
  opts: {
    body?: unknown;
    session?: string;
    query?: Record<string, unknown>;
    method?: "POST" | "PUT" | "DELETE";
  } = {},
) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined && value !== null) qs.set(key, String(value));
  }
  const suffix = qs.toString();
  const headers: Record<string, string> = {};
  if (opts.session) headers["x-t-boards-session"] = opts.session;
  return client.json(
    `/api/forest/${encodeURIComponent(workspaceId)}${path}${suffix ? `?${suffix}` : ""}`,
    opts.body === undefined
      ? { method: opts.method ?? "GET", headers }
      : {
          method: opts.method ?? "POST",
          headers,
          body: JSON.stringify(opts.body),
        },
  );
}
