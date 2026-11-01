import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

async function listAgents() {
  const response = await client["agent-identity"].$get();
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default listAgents;
