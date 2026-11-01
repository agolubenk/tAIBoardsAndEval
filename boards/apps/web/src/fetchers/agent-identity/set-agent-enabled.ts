import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

async function setAgentEnabled(agentId: string, enabled: boolean) {
  const response = await client["agent-identity"][":agentId"].$patch({
    param: { agentId },
    json: { enabled },
  });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export default setAgentEnabled;
