import { z } from "zod";
import type { ToolClient } from "./register.js";
import { type RegisterTool, run } from "./register-tool.js";

export function registerNotebookTools(
  registerTool: RegisterTool,
  client: ToolClient,
) {
  registerTool(
    "notebook_search",
    {
      description:
        "Search the team notebook (repository docs, specs, rules and board cards) by words and, while the embedding worker is online, by meaning. Each hit is a chunk with its heading path and source (kind, ref, title): quote or cite it instead of reading the whole document. A card's ref is its task id.",
      inputSchema: z.object({
        workspaceId: z.string().trim().min(1),
        query: z.string().trim().min(1).max(500),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Maximum hits, 1 to 20. Defaults to 8."),
        mode: z
          .enum(["hybrid", "keyword"])
          .optional()
          .describe(
            "keyword skips the meaning-based pass and answers at once. Defaults to hybrid.",
          ),
      }),
    },
    ({ workspaceId, ...body }) =>
      run(() =>
        client.json(`/api/notebook/${encodeURIComponent(workspaceId)}/search`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      ),
  );
}
