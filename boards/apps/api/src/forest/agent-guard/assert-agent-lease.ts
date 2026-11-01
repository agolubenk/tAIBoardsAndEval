import db from "../../database";
import type { ForestActor } from "../actor";
import { ForestError } from "../forest-error";
import { assertFence } from "../lease/assert-fence";
import { FENCE_HEADER, type AgentHeaders } from "./agent-headers";

// AC-010 on kaneo routes: the agent writes only under its own live lease, or
// its linked group's. The check runs just before the upstream handler, which
// has its own transaction, so a lease lapsing in between is not caught; the
// window is the handler's run, far below the lease length.
export async function assertAgentLease(
  actor: ForestActor,
  taskId: string,
  headers: AgentHeaders,
) {
  const { fencingToken } = headers;
  if (fencingToken === null) {
    throw new ForestError(
      "lease_missing",
      `acquire a lease and send its token in ${FENCE_HEADER}`,
    );
  }
  const { lease } = await db.transaction((tx) =>
    assertFence(tx, {
      taskId,
      fencingToken,
      expectedRevision: headers.expectedRevision,
    }),
  );
  const ownLease = lease.holderId === actor.id;
  const groupLease =
    lease.groupKey !== null && lease.groupKey === headers.groupKey;
  if (!ownLease && !groupLease) {
    throw new ForestError(
      "lease_conflict",
      `held by ${lease.holderName}; the token is not this session's`,
    );
  }
}
