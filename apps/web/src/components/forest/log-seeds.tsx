import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import useLog from "@/hooks/queries/forest/use-log";

type LogSeedsProps = {
  workspaceId: string;
  logId: string;
  selected: ReadonlySet<string>;
  onToggle: (seedId: string, checked: boolean) => void;
};

// A felled tree's description and the seeds it left; loads when the log opens.
export function LogSeeds({
  workspaceId,
  logId,
  selected,
  onToggle,
}: LogSeedsProps) {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useLog(workspaceId, logId);

  if (isLoading) return <Skeleton className="h-10 w-full" />;
  if (isError || !data) {
    return (
      <p role="alert" className="text-muted-foreground text-xs">
        {t("workspace:forest.loadError")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {data.description ? (
        <p className="line-clamp-4 whitespace-pre-wrap break-words text-muted-foreground text-xs">
          {data.description}
        </p>
      ) : null}
      {data.seeds.length ? (
        <ul className="flex flex-col gap-1.5">
          {data.seeds.map((seed) => {
            const id = `seed-${seed.id}`;
            return (
              <li key={seed.id} className="flex items-start gap-2">
                <Checkbox
                  id={id}
                  className="mt-0.5"
                  checked={selected.has(seed.id)}
                  onCheckedChange={(checked) => onToggle(seed.id, checked)}
                />
                <label htmlFor={id} className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 text-[13px]">
                    <Badge variant="outline" size="sm">
                      {seed.kind === "branch" || seed.kind === "links"
                        ? t(`workspace:forest.logs.seedKind.${seed.kind}`)
                        : seed.kind}
                    </Badge>
                    <span className="truncate">{seed.title}</span>
                  </span>
                  <span className="line-clamp-3 whitespace-pre-wrap break-words text-muted-foreground text-xs">
                    {seed.body}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-muted-foreground text-xs">
          {t("workspace:forest.logs.noSeeds")}
        </p>
      )}
    </div>
  );
}
