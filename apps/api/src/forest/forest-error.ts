import { HTTPException } from "hono/http-exception";

export type ForestErrorCode =
  | "lease_conflict"
  | "lease_stale"
  | "lease_missing"
  | "revision_conflict"
  | "felled"
  | "approval_required"
  | "agent_forbidden"
  | "owner_session_required"
  | "not_a_tree"
  | "cross_product"
  | "too_large"
  | "half_baked"
  | "mirror_read_only"
  | "history_conflict";

const STATUS: Record<ForestErrorCode, 400 | 403 | 409 | 410 | 413> = {
  lease_conflict: 409,
  lease_stale: 409,
  lease_missing: 409,
  revision_conflict: 409,
  felled: 410,
  approval_required: 403,
  agent_forbidden: 403,
  owner_session_required: 403,
  not_a_tree: 400,
  cross_product: 400,
  too_large: 413,
  half_baked: 403,
  mirror_read_only: 403,
  history_conflict: 409,
};

// Expected forest refusals carry a machine code so agents can branch on it.
export class ForestError extends HTTPException {
  constructor(
    readonly code: ForestErrorCode,
    message: string,
  ) {
    super(STATUS[code], { message: `${code}: ${message}` });
  }
}
