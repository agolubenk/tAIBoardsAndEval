import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

export type FellTarget =
  | { kind: "tree"; rootId: string }
  | { kind: "sector"; sectorId: string };

// The owner's own session fells without an approval (R-028).
async function fell({
  workspaceId,
  target,
  reason,
}: {
  workspaceId: string;
  target: FellTarget;
  reason: string;
}) {
  const response = await client.forest[":workspaceId"].fell.$post({
    param: { workspaceId },
    json: { ...target, reason },
  });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default fell;
