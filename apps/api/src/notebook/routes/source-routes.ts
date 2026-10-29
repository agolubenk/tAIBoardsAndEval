import {
  apiRouter,
  type BaseVariables,
  createRoute,
  errorResponse,
  jsonResponse,
} from "../../openapi";
import { boundedRequestBody } from "../../utils/bounded-request-body";
import { requireWorkspacePermission } from "../../utils/require-workspace-permission";
import { workspaceAccess } from "../../utils/workspace-access-middleware";
import { notebookEmbedModel } from "../notebook-config";
import { listSources, pruneSources } from "../sources/list-sources";
import { syncCardSources } from "../sources/sync-card-sources";
import { upsertSource } from "../sources/upsert-source";
import {
  cardSyncSchema,
  prunedSchema,
  pruneSourcesBody,
  putSourceBody,
  SOURCE_BODY_BYTES,
  sourcesSchema,
  upsertedSourceSchema,
  workspaceParam,
} from "./schema";

const listSourcesRoute = createRoute({
  method: "get",
  operationId: "listNotebookSources",
  path: "/{workspaceId}/sources",
  tags: ["Notebook"],
  summary: "List notebook sources",
  description:
    "Every source in the workspace notebook with its sha256, so a sync uploads only what changed, and how many of its chunks carry a vector.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["read"] }),
  ] as const,
  request: { params: workspaceParam },
  responses: {
    200: jsonResponse("Notebook sources", sourcesSchema),
    403: errorResponse("Missing workspace:read permission"),
  },
});

const putSourceRoute = createRoute({
  method: "put",
  operationId: "putNotebookSource",
  path: "/{workspaceId}/sources",
  tags: ["Notebook"],
  summary: "Add or replace a notebook source",
  description:
    "Stores the text, cuts it into chunks by headings and queues them for embedding. The same text again changes nothing.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["manage_settings"] }),
    boundedRequestBody(SOURCE_BODY_BYTES),
  ] as const,
  request: {
    params: workspaceParam,
    body: {
      required: true,
      content: { "application/json": { schema: putSourceBody } },
    },
  },
  responses: {
    200: jsonResponse("Source stored", upsertedSourceSchema),
    403: errorResponse("Missing workspace:manage_settings permission"),
    413: errorResponse("Request body is too large"),
  },
});

const pruneSourcesRoute = createRoute({
  method: "post",
  operationId: "pruneNotebookSources",
  path: "/{workspaceId}/sources/prune",
  tags: ["Notebook"],
  summary: "Remove notebook sources that no longer exist",
  description:
    "Deletes every source of the kind whose ref is not in the list, with its chunks.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["manage_settings"] }),
    boundedRequestBody(SOURCE_BODY_BYTES),
  ] as const,
  request: {
    params: workspaceParam,
    body: {
      required: true,
      content: { "application/json": { schema: pruneSourcesBody } },
    },
  },
  responses: {
    200: jsonResponse("Sources pruned", prunedSchema),
    403: errorResponse("Missing workspace:manage_settings permission"),
    413: errorResponse("Request body is too large"),
  },
});

const syncCardsRoute = createRoute({
  method: "post",
  operationId: "syncNotebookCards",
  path: "/{workspaceId}/sources/cards",
  tags: ["Notebook"],
  summary: "Sync the workspace cards into the notebook",
  description:
    "The scheduler runs this every 10 minutes; call it to see a card edit in search sooner. Only cards of active projects that every member may open are kept, since threads are shared by the whole workspace.",
  middleware: [
    workspaceAccess.fromParam(),
    requireWorkspacePermission({ workspace: ["manage_settings"] }),
  ] as const,
  request: { params: workspaceParam },
  responses: {
    200: jsonResponse("Cards synced", cardSyncSchema),
    403: errorResponse("Missing workspace:manage_settings permission"),
  },
});

export const sourceRoutes = apiRouter<BaseVariables & { workspaceId: string }>()
  .openapi(listSourcesRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const model = notebookEmbedModel();
    return c.json(
      { model, sources: await listSources(workspaceId, model) },
      200,
    );
  })
  .openapi(putSourceRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const body = c.req.valid("json");
    return c.json(await upsertSource({ workspaceId, ...body }), 200);
  })
  .openapi(pruneSourcesRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const { kind, keep } = c.req.valid("json");
    return c.json(
      { deleted: await pruneSources(workspaceId, kind, keep) },
      200,
    );
  })
  .openapi(syncCardsRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    return c.json(await syncCardSources(workspaceId), 200);
  });
