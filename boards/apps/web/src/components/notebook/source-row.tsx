import { useTranslation } from "react-i18next";
import { formatDateTime } from "@/lib/format";
import type { NotebookSource } from "./notebook-types";
import { SourceLabel } from "./source-label";

export function SourceRow({ source }: { source: NotebookSource }) {
  const { t } = useTranslation();
  const complete = source.embedded >= source.chunks;

  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2">
      <SourceLabel kind={source.kind} ref_={source.ref} title={source.title} />
      <div className="flex shrink-0 flex-col items-end text-xs">
        <span
          className={
            complete ? "text-muted-foreground" : "text-warning-foreground"
          }
        >
          {t("workspace:notebook.sources.chunks", {
            embedded: source.embedded,
            chunks: source.chunks,
          })}
        </span>
        <span className="text-muted-foreground">
          {formatDateTime(source.updatedAt)}
        </span>
      </div>
    </li>
  );
}
