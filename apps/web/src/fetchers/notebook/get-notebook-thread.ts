import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

async function getNotebookThread(workspaceId: string, threadId: string) {
  const response = await client.notebook[":workspaceId"].threads[
    ":threadId"
  ].$get({ param: { workspaceId, threadId } });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default getNotebookThread;
