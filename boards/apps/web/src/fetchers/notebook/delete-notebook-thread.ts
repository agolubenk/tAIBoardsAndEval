import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

async function deleteNotebookThread(workspaceId: string, threadId: string) {
  const response = await client.notebook[":workspaceId"].threads[
    ":threadId"
  ].$delete({ param: { workspaceId, threadId } });
  if (!response.ok) throw await HttpError.fromResponse(response);
}

export default deleteNotebookThread;
