import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/ui/skeleton";

type ForestListStateProps = {
  isLoading: boolean;
  isError: boolean;
  isEmpty: boolean;
  empty: string;
  children: ReactNode;
};

// Loading, error and empty states shared by the forest tabs.
export function ForestListState({
  isLoading,
  isError,
  isEmpty,
  empty,
  children,
}: ForestListStateProps) {
  const { t } = useTranslation();

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2">
        {[1, 2, 3].map((row) => (
          <Skeleton key={row} className="h-11 w-full rounded-lg" />
        ))}
      </div>
    );
  }
  if (isError) {
    return (
      <p role="alert" className="py-6 text-muted-foreground text-sm">
        {t("workspace:forest.loadError")}
      </p>
    );
  }
  if (isEmpty) {
    return (
      <p className="rounded-lg border border-dashed px-4 py-8 text-center text-muted-foreground text-sm">
        {empty}
      </p>
    );
  }
  return <>{children}</>;
}
