import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

async function listCardWorkers(workspaceId: string, projectId: string) {
  const response = await client.forest[":workspaceId"].workers.$get({
    param: { workspaceId },
    query: { projectId },
  });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default listCardWorkers;
