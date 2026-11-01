import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

async function detectSectors(workspaceId: string) {
  const response = await client.forest[":workspaceId"].sectors.detect.$post({
    param: { workspaceId },
  });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default detectSectors;
