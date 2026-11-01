import { useQuery } from "@tanstack/react-query";
import listAgents from "@/fetchers/agent-identity/list-agents";
import { agentKeys } from "./agent-keys";

function useAgents() {
  return useQuery({ queryKey: agentKeys.all, queryFn: listAgents });
}

export default useAgents;
