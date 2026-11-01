import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

async function getLog(workspaceId: string, logId: string) {
  const response = await client.forest[":workspaceId"].logs[":logId"].$get({
    param: { workspaceId, logId },
  });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default getLog;
