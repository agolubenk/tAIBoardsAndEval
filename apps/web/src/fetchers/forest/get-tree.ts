import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

async function getTree(workspaceId: string, rootId: string) {
  const response = await client.forest[":workspaceId"].trees[":rootId"].$get({
    param: { workspaceId, rootId },
  });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default getTree;
