import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

async function listToolSets() {
  const response = await client["agent-identity"]["tool-sets"].$get();
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default listToolSets;
