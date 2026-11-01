import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

async function listBoardBugs(workspaceId: string, projectId: string) {
  const response = await client.forest[":workspaceId"].bugs.$get({
    param: { workspaceId },
    query: { projectId },
  });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default listBoardBugs;
