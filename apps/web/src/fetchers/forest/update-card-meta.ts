import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

export type CardMetaPatch = Parameters<
  (typeof client.forest)[":workspaceId"]["cards"][":taskId"]["meta"]["$put"]
>[0]["json"];

async function updateCardMeta({
  workspaceId,
  taskId,
  patch,
}: {
  workspaceId: string;
  taskId: string;
  patch: CardMetaPatch;
}) {
  const response = await client.forest[":workspaceId"].cards[
    ":taskId"
  ].meta.$put({ param: { workspaceId, taskId }, json: patch });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default updateCardMeta;
