import { z } from "zod";
import type { ToolClient } from "../register.js";
import { type RegisterTool, run } from "../register-tool.js";
import { forestCall, id, sessionField } from "./request.js";

// R-037: the session's step, branch and what it waits for live on the board,
// where the owner and other sessions read them.
export function registerForestWorkStateTools(
  registerTool: RegisterTool,
  client: ToolClient,
) {
  registerTool(
    "forest_list_work_state",
    {
      description:
        "What each session in the workspace is doing: step, branch, what it waits for and its card, latest first. Read it instead of asking a session for its status.",
      inputSchema: z.object({ workspaceId: id }),
    },
    ({ workspaceId }) =>
      run(() => forestCall(client, workspaceId, "/work-state")),
  );

  registerTool(
    "forest_set_work_state",
    {
      description:
        "Record your session's working state after each step: what you do now, the branch, what you wait for and the card. Replaces your previous state; omitted optional fields are cleared.",
      inputSchema: z.object({
        workspaceId: id,
        session: sessionField,
        step: z.string().trim().min(1).max(500),
        taskId: id.optional(),
        branch: z.string().trim().min(1).max(200).optional(),
        waiting: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .optional()
          .describe("A review, an owner's answer, a CI run…"),
      }),
    },
    ({ workspaceId, session, ...body }) =>
      run(() =>
        forestCall(client, workspaceId, "/work-state", {
          body,
          session,
          method: "PUT",
        }),
      ),
  );

  registerTool(
    "forest_clear_work_state",
    {
      description: "Remove your session's working state when the work is done.",
      inputSchema: z.object({ workspaceId: id, session: sessionField }),
    },
    ({ workspaceId, session }) =>
      run(() =>
        forestCall(client, workspaceId, "/work-state", {
          session,
          method: "DELETE",
        }),
      ),
  );
}
