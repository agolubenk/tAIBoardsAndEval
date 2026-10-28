import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

async function listLogs(workspaceId: string, q: string, cursor?: string) {
  const query: { q?: string; cursor?: string } = {};
  if (q) query.q = q;
  if (cursor) query.cursor = cursor;
  const response = await client.forest[":workspaceId"].logs.$get({
    param: { workspaceId },
    query,
  });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default listLogs;
