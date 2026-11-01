import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

async function listTrees(workspaceId: string, projectId?: string) {
  const response = await client.forest[":workspaceId"].trees.$get({
    param: { workspaceId },
    query: projectId ? { projectId } : {},
  });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default listTrees;
