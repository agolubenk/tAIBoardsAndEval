export type StoredLease = {
  holderId: string;
  holderName: string;
  groupKey: string | null;
  fencingToken: number;
  expiresAt: Date;
};

export type AcquireRequest = { holderId: string; groupKey: string | null };

export type AcquireDecision =
  | { kind: "insert"; fencingToken: 1 }
  | { kind: "extend"; fencingToken: number }
  | { kind: "takeover"; fencingToken: number }
  | { kind: "conflict"; holderName: string; expiresAt: Date };

// A live lease is renewed by its holder or shared by a linked session of the
// same group under the same token (R-026). Anyone else waits for it to lapse;
// taking over a lapsed lease issues a strictly greater token (I6).
export function decideAcquire(
  existing: StoredLease | null,
  request: AcquireRequest,
  now: Date,
): AcquireDecision {
  if (!existing) return { kind: "insert", fencingToken: 1 };
  if (existing.expiresAt.getTime() <= now.getTime()) {
    return { kind: "takeover", fencingToken: existing.fencingToken + 1 };
  }
  const sameHolder = existing.holderId === request.holderId;
  const sameGroup =
    request.groupKey !== null && existing.groupKey === request.groupKey;
  if (sameHolder || sameGroup) {
    return { kind: "extend", fencingToken: existing.fencingToken };
  }
  return {
    kind: "conflict",
    holderName: existing.holderName,
    expiresAt: existing.expiresAt,
  };
}
