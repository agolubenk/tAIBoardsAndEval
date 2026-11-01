import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

async function getCardMemory(workspaceId: string, taskId: string) {
  const response = await client.forest[":workspaceId"].cards[
    ":taskId"
  ].memory.$get({ param: { workspaceId, taskId } });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default getCardMemory;
