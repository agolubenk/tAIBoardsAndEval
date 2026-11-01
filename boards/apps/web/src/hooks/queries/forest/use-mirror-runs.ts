import { useQuery } from "@tanstack/react-query";
import listMirrorRuns from "@/fetchers/forest/list-mirror-runs";
import { forestKeys } from "./forest-keys";

// Runs come every two hours; poll faster only while one is in progress, so a
// manual run's report shows up without a reload.
function useMirrorRuns(workspaceId: string) {
  return useQuery({
    queryKey: [...forestKeys.all(workspaceId), "mirror"],
    queryFn: () => listMirrorRuns(workspaceId),
    enabled: Boolean(workspaceId),
    refetchInterval: (query) =>
      query.state.data?.runs[0]?.status === "running" ? 10_000 : 300_000,
  });
}

export default useMirrorRuns;
