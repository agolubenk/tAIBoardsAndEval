import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

async function decideApproval({
  workspaceId,
  approvalId,
  decision,
}: {
  workspaceId: string;
  approvalId: string;
  decision: "approved" | "rejected";
}) {
  const response = await client.forest[":workspaceId"].approvals[
    ":approvalId"
  ].decide.$post({
    param: { workspaceId, approvalId },
    json: { decision },
  });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default decideApproval;
