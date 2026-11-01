import type { Context } from "hono";

// How an agent proves its lease and its «да» on a kaneo route: headers, so
// the upstream request bodies and their validators stay as they are.
export const FENCE_HEADER = "x-t-boards-fence";
export const GROUP_HEADER = "x-t-boards-group";
export const REVISION_HEADER = "x-t-boards-revision";
export const APPROVAL_HEADER = "x-t-boards-approval";

export type AgentHeaders = {
  fencingToken: number | null;
  groupKey: string | null;
  expectedRevision: number | undefined;
  approvalId: string | null;
};

function positiveInt(raw: string | undefined) {
  if (!raw || !/^\d{1,9}$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return value > 0 ? value : null;
}

function shortText(raw: string | undefined) {
  const value = raw?.trim();
  return value && value.length <= 200 ? value : null;
}

export function readAgentHeaders(c: Context): AgentHeaders {
  return {
    fencingToken: positiveInt(c.req.header(FENCE_HEADER)),
    groupKey: shortText(c.req.header(GROUP_HEADER)),
    expectedRevision: positiveInt(c.req.header(REVISION_HEADER)) ?? undefined,
    approvalId: shortText(c.req.header(APPROVAL_HEADER)),
  };
}
