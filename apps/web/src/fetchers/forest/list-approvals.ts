import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

export type ApprovalStatusFilter = NonNullable<
  Parameters<
    (typeof client.forest)[":workspaceId"]["approvals"]["$get"]
  >[0]["query"]["status"]
>;

async function listApprovals(
  workspaceId: string,
  status?: ApprovalStatusFilter,
) {
  const response = await client.forest[":workspaceId"].approvals.$get({
    param: { workspaceId },
    query: status ? { status } : {},
  });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default listApprovals;
