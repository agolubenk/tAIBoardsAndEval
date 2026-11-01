import {
  apiRouter,
  createRoute,
  errorResponse,
  jsonResponse,
} from "../openapi";
import { requireUserSession } from "../utils/require-user-session";
import { requireWorkspacePermission } from "../utils/require-workspace-permission";
import { workspaceAccess } from "../utils/workspace-access-middleware";
import {
  pipelineSettingsSchema,
  updatePipelineSettingsBody,
  workspaceIdParam,
} from "./schema";
import {
  readPipelineSettings,
  type StoredPipelineSettings,
  updatePipelineSettings,
} from "./store";

const toResponse = (s: StoredPipelineSettings) => ({
  automation: s.automation,
  toggles: s.toggles,
  updatedAt: s.updatedAt ? s.updatedAt.toISOString() : null,
  updatedBy: s.updatedBy,
});

const getRoute = createRoute({
  method: "get",
  operationId: "getPipelineSettings",
  path: "/workspace/{workspaceId}",
  tags: ["Pipeline settings"],
  summary: "Get the workspace's pipeline settings",
  description:
    "Which automated parts of the team process run for this workspace (product). Readable by members and by API keys of the workspace — sessions and tools read it to decide whether to run.",
  middleware: [workspaceAccess.fromParam()] as const,
  request: { params: workspaceIdParam },
  responses: {
    200: jsonResponse("Pipeline settings", pipelineSettingsSchema),
    404: errorResponse("Workspace not found"),
  },
});

const updateRoute = createRoute({
  method: "put",
  operationId: "updatePipelineSettings",
  path: "/workspace/{workspaceId}",
  tags: ["Pipeline settings"],
  summary: "Update the workspace's pipeline settings",
  description:
    "Turns automated parts of the process on or off. People with the workspace's manage-settings permission only: API keys and agents cannot change what automation may do.",
  middleware: [
    workspaceAccess.fromParam(),
    requireUserSession,
    requireWorkspacePermission({ workspace: ["manage_settings"] }),
  ] as const,
  request: {
    params: workspaceIdParam,
    body: {
      required: true,
      content: { "application/json": { schema: updatePipelineSettingsBody } },
    },
  },
  responses: {
    200: jsonResponse("Updated pipeline settings", pipelineSettingsSchema),
    400: errorResponse("Invalid settings"),
    403: errorResponse("Missing permission or not a user session"),
    404: errorResponse("Workspace not found"),
  },
});

const pipelineSettings = apiRouter()
  .openapi(getRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    return c.json(toResponse(await readPipelineSettings(workspaceId)), 200);
  })
  .openapi(updateRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const next = await updatePipelineSettings(
      workspaceId,
      c.req.valid("json"),
      c.get("userId"),
    );
    return c.json(toResponse(next), 200);
  });

export default pipelineSettings;
