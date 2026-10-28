import { useQuery } from "@tanstack/react-query";
import listApprovals, {
  type ApprovalStatusFilter,
} from "@/fetchers/forest/list-approvals";
import { forestKeys } from "./forest-keys";

function useApprovals(workspaceId: string, status?: ApprovalStatusFilter) {
  return useQuery({
    queryKey: [...forestKeys.all(workspaceId), "approvals", status ?? "all"],
    queryFn: () => listApprovals(workspaceId, status),
    enabled: Boolean(workspaceId),
  });
}

export default useApprovals;
