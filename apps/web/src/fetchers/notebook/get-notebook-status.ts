import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

async function getNotebookStatus(workspaceId: string) {
  const response = await client.notebook[":workspaceId"].status.$get({
    param: { workspaceId },
  });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default getNotebookStatus;
