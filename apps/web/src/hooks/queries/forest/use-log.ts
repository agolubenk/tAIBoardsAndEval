import { useQuery } from "@tanstack/react-query";
import getLog from "@/fetchers/forest/get-log";
import { forestKeys } from "./forest-keys";

function useLog(workspaceId: string, logId: string | null) {
  return useQuery({
    queryKey: [...forestKeys.all(workspaceId), "log", logId],
    queryFn: () => getLog(workspaceId, logId ?? ""),
    enabled: Boolean(workspaceId && logId),
  });
}

export default useLog;
