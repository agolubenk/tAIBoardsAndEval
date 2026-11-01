import { useQuery } from "@tanstack/react-query";
import listBoardBugs from "@/fetchers/forest/list-board-bugs";
import { forestKeys } from "./forest-keys";

export type BoardBug = Awaited<ReturnType<typeof listBoardBugs>>[number];

const byTask = (bugs: BoardBug[]) =>
  new Map(bugs.map((bug) => [bug.taskId, bug]));

// One request per board: every card on it reads the same cached map. A card
// edited on its page refreshes it with the rest of the forest reads.
function useBoardBugs(workspaceId: string, projectId: string) {
  return useQuery({
    queryKey: [...forestKeys.all(workspaceId), "bugs", projectId],
    queryFn: () => listBoardBugs(workspaceId, projectId),
    enabled: Boolean(workspaceId && projectId),
    select: byTask,
    // Agents mark bugs through MCP without the page knowing.
    refetchInterval: 60_000,
  });
}

export default useBoardBugs;
