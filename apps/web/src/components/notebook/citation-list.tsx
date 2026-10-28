import { useTranslation } from "react-i18next";
import { citationAnchor } from "./citation-anchor";
import type { NotebookCitation } from "./notebook-types";
import { SourceLabel } from "./source-label";

type CitationListProps = {
  messageId: string;
  citations: NotebookCitation[];
};

export function CitationList({ messageId, citations }: CitationListProps) {
  const { t } = useTranslation();
  if (citations.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5 border-t pt-2">
      <p className="font-medium text-muted-foreground text-xs">
        {t("workspace:notebook.chat.sources")}
      </p>
      <ol className="flex flex-col gap-1.5">
        {citations.map((citation) => (
          <li
            key={citation.n}
            id={citationAnchor(messageId, citation.n)}
            className="flex gap-2 rounded-md px-1 py-0.5 target:bg-accent"
          >
            <span className="shrink-0 pt-px font-mono text-muted-foreground text-xs tabular-nums">
              [{citation.n}]
            </span>
            <SourceLabel
              kind={citation.kind}
              ref_={citation.ref}
              title={citation.title}
              heading={citation.heading}
            />
          </li>
        ))}
      </ol>
    </div>
  );
}
