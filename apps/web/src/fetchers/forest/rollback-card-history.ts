import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

async function rollbackCardHistory({
  workspaceId,
  taskId,
  historyId,
}: {
  workspaceId: string;
  taskId: string;
  historyId: string;
}) {
  const response = await client.forest[":workspaceId"].cards[":taskId"].history[
    ":historyId"
  ].rollback.$post({
    param: { workspaceId, taskId, historyId },
  });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default rollbackCardHistory;
