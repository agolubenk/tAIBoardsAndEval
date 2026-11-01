import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

async function grow({
  workspaceId,
  seedIds,
  name,
  slug,
}: {
  workspaceId: string;
  seedIds: string[];
  name: string;
  slug: string;
}) {
  const response = await client.forest[":workspaceId"].grow.$post({
    param: { workspaceId },
    json: { seedIds, name, slug },
  });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default grow;
