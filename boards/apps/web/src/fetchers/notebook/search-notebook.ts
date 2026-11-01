import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

async function searchNotebook(workspaceId: string, query: string) {
  const response = await client.notebook[":workspaceId"].search.$post({
    param: { workspaceId },
    json: { query },
  });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default searchNotebook;
