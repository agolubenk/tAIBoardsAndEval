import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

async function listWorkState(workspaceId: string) {
  const response = await client.forest[":workspaceId"]["work-state"].$get({
    param: { workspaceId },
  });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default listWorkState;
