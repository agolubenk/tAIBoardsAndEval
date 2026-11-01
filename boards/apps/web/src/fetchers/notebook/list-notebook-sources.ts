import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

async function listNotebookSources(workspaceId: string) {
  const response = await client.notebook[":workspaceId"].sources.$get({
    param: { workspaceId },
  });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default listNotebookSources;
