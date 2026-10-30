import { useQuery } from "@tanstack/react-query";
import useAuth from "@/components/providers/auth-provider/hooks/use-auth";
import { getNotebookModel } from "@/fetchers/admin/get-notebook-model";

export const NOTEBOOK_MODEL_QUERY_KEY = ["admin", "notebook-model"] as const;

function useNotebookModel() {
  const { user } = useAuth();
  const userId = user?.id ?? "";
  return useQuery({
    queryKey: [...NOTEBOOK_MODEL_QUERY_KEY, userId],
    queryFn: getNotebookModel,
    enabled: userId !== "",
  });
}

export default useNotebookModel;
