import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

async function askNotebookThread({
  workspaceId,
  threadId,
  question,
}: {
  workspaceId: string;
  threadId: string;
  question: string;
}) {
  const response = await client.notebook[":workspaceId"].threads[
    ":threadId"
  ].messages.$post({
    param: { workspaceId, threadId },
    json: { question },
  });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default askNotebookThread;
