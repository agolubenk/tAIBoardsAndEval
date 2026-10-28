import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

async function listNotebookThreads(workspaceId: string) {
  const response = await client.notebook[":workspaceId"].threads.$get({
    param: { workspaceId },
  });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default listNotebookThreads;
