import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

async function listSectors(workspaceId: string) {
  const response = await client.forest[":workspaceId"].sectors.$get({
    param: { workspaceId },
    query: {},
  });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default listSectors;
