import {
  apiRouter,
  createRoute,
  errorResponse,
  jsonResponse,
} from "../openapi";
import { requireInstanceAdmin } from "../utils/require-instance-admin";
import { requireUserSession } from "../utils/require-user-session";
import { notebookModelView } from "./notebook-model-view";
import { notebookModelSchema, updateNotebookModelBody } from "./schema";
import { updateNotebookModel } from "./update-notebook-model";

const forbidden = errorResponse(
  "The caller is not an instance administrator or is authenticated with an API key",
);

const getRoute = createRoute({
  method: "get",
  operationId: "getNotebookModelSettings",
  path: "/",
  tags: ["Admin"],
  summary: "Get the notebook model settings",
  description:
    "The answer model, embedding model, daily limit and today's calls per workspace, shared by every workspace on this instance. The model key is never returned, only whether one is set.",
  middleware: [requireUserSession, requireInstanceAdmin] as const,
  responses: {
    200: jsonResponse("Notebook model settings", notebookModelSchema),
    403: forbidden,
  },
});

const updateRoute = createRoute({
  method: "put",
  operationId: "updateNotebookModelSettings",
  path: "/",
  tags: ["Admin"],
  summary: "Update the notebook model settings",
  description:
    "Sets the instance's answer model, embedding model, daily limit or model key. The key is stored encrypted with the server's settings key. Changing the embedding model re-embeds every notebook in the background.",
  middleware: [requireUserSession, requireInstanceAdmin] as const,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: updateNotebookModelBody } },
    },
  },
  responses: {
    200: jsonResponse("Updated notebook model settings", notebookModelSchema),
    400: errorResponse("Invalid settings"),
    403: forbidden,
    409: errorResponse("The server cannot store a model key"),
  },
});

const notebookModel = apiRouter()
  .openapi(getRoute, async (c) => c.json(await notebookModelView(), 200))
  .openapi(updateRoute, async (c) => {
    await updateNotebookModel(c.req.valid("json"), c.get("userId"));
    return c.json(await notebookModelView(), 200);
  });

export default notebookModel;
