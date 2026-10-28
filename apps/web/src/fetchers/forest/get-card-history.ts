import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

async function getCardHistory(workspaceId: string, taskId: string) {
  const response = await client.forest[":workspaceId"].cards[
    ":taskId"
  ].history.$get({ param: { workspaceId, taskId }, query: {} });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default getCardHistory;
