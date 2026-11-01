import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

async function startNotebookThread(workspaceId: string, question: string) {
  const response = await client.notebook[":workspaceId"].threads.$post({
    param: { workspaceId },
    json: { question },
  });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default startNotebookThread;
