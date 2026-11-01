import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

async function listMirrorRuns(workspaceId: string) {
  const response = await client.forest[":workspaceId"].mirror.runs.$get({
    param: { workspaceId },
  });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default listMirrorRuns;
