import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

export type JournalFilter = { actor: "agent" | "all"; denied: boolean };

async function listJournal(
  workspaceId: string,
  filter: JournalFilter,
  cursor?: string,
) {
  const query: { actor: "agent" | "all"; outcome?: "denied"; cursor?: string } =
    { actor: filter.actor };
  if (filter.denied) query.outcome = "denied";
  if (cursor) query.cursor = cursor;
  const response = await client.forest[":workspaceId"].journal.$get({
    param: { workspaceId },
    query,
  });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default listJournal;
