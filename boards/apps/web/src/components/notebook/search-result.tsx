import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import type { NotebookSearchResult } from "./notebook-types";
import { SourceLabel } from "./source-label";

export function SearchResult({ result }: { result: NotebookSearchResult }) {
  const { t } = useTranslation();

  return (
    <li className="flex flex-col gap-1.5 rounded-lg border bg-card px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <SourceLabel
          kind={result.source.kind}
          ref_={result.source.ref}
          title={result.source.title}
          heading={result.heading}
        />
        <div className="flex shrink-0 gap-1">
          {result.matchedBy.map((by) => (
            <Badge key={by} variant="outline" size="sm">
              {t(`workspace:notebook.search.matchedBy.${by}`)}
            </Badge>
          ))}
        </div>
      </div>
      <p className="line-clamp-4 whitespace-pre-wrap break-words text-muted-foreground text-sm">
        {result.text}
      </p>
    </li>
  );
}
