import {
  apiRouter,
  type BaseVariables,
  createRoute,
  errorResponse,
  jsonResponse,
  z,
} from "../../openapi";
import { requireWorkspacePermission } from "../../utils/require-workspace-permission";
import { workspaceAccess } from "../../utils/workspace-access-middleware";
import { resolveForestActor } from "../actor";
import { assertNotHalfBaked } from "../card/assert-not-half-baked";
import { acquireLease } from "../lease/acquire-lease";
import { releaseLease } from "../lease/release-lease";
import { assertTaskInWorkspace } from "../task-scope";
import {
  acquireLeaseBody,
  leaseGrantSchema,
  releaseLeaseBody,
  workspaceParam,
} from "./schema";

const acquireLeaseRoute = createRoute({
  method: "post",
  operationId: "acquireForestLease",
  path: "/{workspaceId}/leases",
  tags: ["Forest"],
  summary: "Take or extend a task lease",
  description:
    "Takes the task's lease for a session, extends it for the holder or a session with the same groupKey, or takes over a lapsed one with a higher fencing token. A live lease of someone else answers 409 with the holder's name.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ task: ["update"] }),
  ] as const,
  request: {
    params: workspaceParam,
    body: {
      required: true,
      content: { "application/json": { schema: acquireLeaseBody } },
    },
  },
  responses: {
    200: jsonResponse("The lease grant", leaseGrantSchema),
    403: errorResponse(
      "Missing task:update permission or project access, or an agent on a half-baked card",
    ),
    404: errorResponse("Task not found"),
    409: errorResponse("Another session holds the lease"),
    410: errorResponse("The task was felled"),
  },
});

const releaseLeaseRoute = createRoute({
  method: "post",
  operationId: "releaseForestLease",
  path: "/{workspaceId}/leases/release",
  tags: ["Forest"],
  summary: "Release a task lease",
  description:
    "Ends the lease early. A stale fencing token changes nothing, so it cannot end a newer holder's lease.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ task: ["update"] }),
  ] as const,
  request: {
    params: workspaceParam,
    body: {
      required: true,
      content: { "application/json": { schema: releaseLeaseBody } },
    },
  },
  responses: {
    200: jsonResponse(
      "Whether the lease was released",
      z.object({ released: z.boolean() }),
    ),
    403: errorResponse("Missing task:update permission or project access"),
    404: errorResponse("Task not found"),
    410: errorResponse("The task was felled"),
  },
});

export const leaseRoutes = apiRouter<BaseVariables & { workspaceId: string }>()
  .openapi(acquireLeaseRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const body = c.req.valid("json");
    await assertTaskInWorkspace(body.taskId, workspaceId, c.get("userId"));
    const actor = resolveForestActor(c);
    await assertNotHalfBaked(actor, body.taskId, workspaceId);
    const grant = await acquireLease({
      taskId: body.taskId,
      actor,
      groupKey: body.groupKey ?? null,
      ttlSeconds: body.ttlSeconds,
    });
    return c.json(grant, 200);
  })
  .openapi(releaseLeaseRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const body = c.req.valid("json");
    await assertTaskInWorkspace(body.taskId, workspaceId, c.get("userId"));
    return c.json(await releaseLease(body.taskId, body.fencingToken), 200);
  });
