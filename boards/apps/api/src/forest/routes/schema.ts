import {
  nullableResponseTimestamp,
  pagingNumber,
  responseTimestamp,
  z,
} from "../../openapi";
import { APPROVAL_ACTIONS } from "../approval/approval-params";
import { LEASE_MAX_SECONDS } from "../lease/acquire-lease";
import { APPROVAL_STATUSES } from "../read/list-approvals";
import { PAGE_MAX } from "../read/page-cursor";

export const workspaceParam = z.object({ workspaceId: z.string() });

export const pageQuery = z.object({
  cursor: z.string().max(200).optional(),
  take: pagingNumber(1, PAGE_MAX).optional(),
});

// Leases (R-026)
export const acquireLeaseBody = z.object({
  taskId: z.string(),
  groupKey: z.string().max(120).nullish().openapi({
    description: "Linked sessions share a lease by sending the same key.",
  }),
  ttlSeconds: z.number().int().min(30).max(LEASE_MAX_SECONDS).optional(),
});

export const releaseLeaseBody = z.object({
  taskId: z.string(),
  fencingToken: z.number().int().positive(),
});

export const leaseGrantSchema = z
  .object({
    taskId: z.string(),
    fencingToken: z.number(),
    expiresAt: responseTimestamp,
    revision: z.number(),
  })
  .openapi("ForestLeaseGrant");

// Approvals (N-011)
export const requestApprovalBody = z.object({
  action: z.enum(APPROVAL_ACTIONS),
  targetId: z.string(),
  value: z.string().min(1).max(64).optional().openapi({
    description:
      "close_task: the closing status; reopen_task: the open status a closed card returns to; set_priority: the new priority. Part of what the owner approves.",
  }),
  reason: z.string().min(1).max(2000),
});

export const decideApprovalBody = z.object({
  decision: z.enum(["approved", "rejected"]),
});

export const approvalParam = workspaceParam.extend({ approvalId: z.string() });

export const approvalQuery = pageQuery.extend({
  status: z.enum(APPROVAL_STATUSES).optional(),
});

export const approvalSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    action: z.string(),
    targetType: z.string(),
    targetId: z.string(),
    params: z.record(z.string(), z.string()).nullable(),
    reason: z.string().nullable(),
    requestedByKind: z.string(),
    requestedById: z.string(),
    requestedByName: z.string(),
    status: z.string(),
    decidedVia: z.string().nullable(),
    decidedAt: nullableResponseTimestamp,
    consumedAt: nullableResponseTimestamp,
    expiresAt: responseTimestamp,
    createdAt: responseTimestamp,
  })
  .openapi("ForestApproval");

export const approvalListItemSchema = approvalSchema
  .extend({
    target: z
      .object({
        title: z.string(),
        number: z.number().nullable(),
        projectId: z.string().nullable(),
        projectName: z.string().nullable(),
      })
      .nullable()
      .openapi({
        description:
          "The card (number, title, project) or sector (name) the request is about; null when it is gone or the caller cannot open its project.",
      }),
  })
  .openapi("ForestApprovalListItem");

// Felling (R-028, R-029)
export const fellBody = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tree"),
    rootId: z.string(),
    approvalId: z.string().optional(),
    reason: z.string().min(1).max(2000),
  }),
  z.object({
    kind: z.literal("sector"),
    sectorId: z.string(),
    approvalId: z.string().optional(),
    reason: z.string().min(1).max(2000),
  }),
]);

export const fellResultSchema = z
  .object({
    fellingId: z.string(),
    logIds: z.array(z.string()),
    seedCount: z.number(),
    taskCount: z.number(),
  })
  .openapi("ForestFellResult");

// Sectors
export const sectorQuery = z.object({
  status: z.enum(["active", "stale", "felled"]).optional(),
});

export const sectorSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    detectedBy: z.string(),
    status: z.string(),
    fellingId: z.string().nullable(),
    createdAt: responseTimestamp,
    treeIds: z.array(z.string()),
  })
  .openapi("ForestSector");

export const detectedSectorSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    treeIds: z.array(z.string()),
    created: z.boolean(),
  })
  .openapi("ForestDetectedSector");

// Logs and seeds
export const logQuery = pageQuery.extend({
  q: z.string().max(200).optional(),
});

export const logParam = workspaceParam.extend({ logId: z.string() });

export const logSummarySchema = z
  .object({
    id: z.string(),
    title: z.string(),
    taskNumber: z.number().nullable(),
    finalStatus: z.string(),
    priority: z.string(),
    sourceProjectId: z.string(),
    sourceProjectName: z.string(),
    fellingId: z.string(),
    felledAt: responseTimestamp,
  })
  .openapi("ForestLogSummary");

export const seedSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    title: z.string(),
    body: z.string(),
    sourceTaskIds: z.array(z.string()),
    contentHash: z.string(),
    compressor: z.string(),
    revision: z.number(),
    createdAt: responseTimestamp,
  })
  .openapi("ForestSeed");

export const logSchema = logSummarySchema
  .extend({
    workspaceId: z.string(),
    sourceTaskId: z.string(),
    description: z.string().nullable(),
    fields: z.record(z.string(), z.unknown()),
    history: z.array(z.record(z.string(), z.unknown())),
    felledTaskIds: z.array(z.string()),
    seeds: z.array(seedSchema),
  })
  .openapi("ForestLog");

export const growBody = z.object({
  seedIds: z.array(z.string()).min(1).max(100),
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(20),
  icon: z.string().max(60).optional(),
});

export const growResultSchema = z
  .object({ projectId: z.string(), taskIds: z.array(z.string()) })
  .openapi("ForestGrowResult");
