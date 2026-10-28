import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

async function listLeases(workspaceId: string) {
  const response = await client.forest[":workspaceId"].leases.$get({
    param: { workspaceId },
  });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default listLeases;
