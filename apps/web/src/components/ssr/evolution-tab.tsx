import { useTranslation } from "react-i18next";
import { listSsrTimeline, type SsrTimelineEvent } from "@/fetchers/ssr/ssr-fetchers";
import { useQuery } from "@tanstack/react-query";

const originLabels: Record<string, string> = {
  sync: "sync",
  rollback: "rollback",
  owner: "owner",
};

// «Эволюция сессий» (spec RU-2): one feed of everything that changed in the
// team's settings — skills, rules, agents, genomes, prompts — newest first,
// with the version lifecycle visible (draft → latest → superseded).
export function EvolutionTab({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const timeline = useQuery({
    queryKey: ["ssr", "timeline", workspaceId],
    queryFn: () => listSsrTimeline(workspaceId),
  });

  if (timeline.isPending) {
    return <p className="text-muted-foreground px-1 py-8 text-sm">{t("common:loading")}</p>;
  }
  if (timeline.isError) {
    return (
      <p className="text-destructive px-1 py-8 text-sm">
        {t("workspace:ssr.loadError")}
      </p>
    );
  }
  const events = timeline.data ?? [];
  if (events.length === 0) {
    return (
      <p className="text-muted-foreground px-1 py-8 text-sm">{t("workspace:ssr.empty")}</p>
    );
  }

  return (
    <ol className="flex flex-col gap-3">
      {events.map((event: SsrTimelineEvent) => (
        <li
          key={event.versionId}
          className="rounded-md border border-border bg-card px-4 py-3"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-medium">{event.entityName}</span>
              <span className="text-muted-foreground font-mono text-xs">
                {event.entityKind} · v{event.number}
              </span>
              <span className="text-muted-foreground text-xs">
                {originLabels[event.origin] ?? event.origin} · {event.status}
              </span>
            </div>
            <time className="text-muted-foreground text-xs" dateTime={event.createdAt}>
              {new Date(event.createdAt).toLocaleString()}
            </time>
          </div>
          {event.message ? (
            <p className="text-muted-foreground mt-1 text-sm">{event.message}</p>
          ) : null}
          {event.commitSha ? (
            <p className="text-muted-foreground mt-1 font-mono text-xs">
              {event.commitSha.slice(0, 10)}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
