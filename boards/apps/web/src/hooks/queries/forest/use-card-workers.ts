import { useQuery } from "@tanstack/react-query";
import listCardWorkers from "@/fetchers/forest/list-card-workers";
import { forestKeys } from "./forest-keys";

export type CardWorker = Awaited<ReturnType<typeof listCardWorkers>>[number];

const byTask = (workers: CardWorker[]) =>
  new Map(workers.map((worker) => [worker.taskId, worker]));

// One request per board: every card on it reads the same cached map.
function useCardWorkers(workspaceId: string, projectId: string) {
  return useQuery({
    queryKey: [...forestKeys.all(workspaceId), "workers", projectId],
    queryFn: () => listCardWorkers(workspaceId, projectId),
    enabled: Boolean(workspaceId && projectId),
    select: byTask,
    // Agents take leases and write their state through MCP without the page knowing.
    refetchInterval: 60_000,
  });
}

export default useCardWorkers;
