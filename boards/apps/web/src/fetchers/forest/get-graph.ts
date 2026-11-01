import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

async function getGraph(workspaceId: string, cursor?: string) {
  const response = await client.forest[":workspaceId"].graph.$get({
    param: { workspaceId },
    query: cursor ? { cursor } : {},
  });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default getGraph;
