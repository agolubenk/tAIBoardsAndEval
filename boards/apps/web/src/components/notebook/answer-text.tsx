import { useMemo } from "react";
import { citationAnchor } from "./citation-anchor";
import type { NotebookCitation } from "./notebook-types";
import { splitCitations } from "./split-citations";

type AnswerTextProps = {
  messageId: string;
  content: string;
  citations: NotebookCitation[];
};

// The model's text as plain text (never HTML), with [n] turned into buttons
// that bring the cited source line into view.
export function AnswerText({ messageId, content, citations }: AnswerTextProps) {
  const parts = useMemo(
    () => splitCitations(content, new Set(citations.map((c) => c.n))),
    [content, citations],
  );

  return (
    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
      {parts.map((part) =>
        part.kind === "text" ? (
          <span key={part.at}>{part.text}</span>
        ) : (
          <button
            key={part.at}
            type="button"
            className="mx-0.5 rounded px-0.5 align-super font-mono text-[10px] text-primary hover:bg-accent focus-visible:outline-2"
            onClick={() =>
              document
                .getElementById(citationAnchor(messageId, part.n))
                ?.scrollIntoView({ block: "nearest", behavior: "smooth" })
            }
          >
            [{part.n}]
          </button>
        ),
      )}
    </p>
  );
}
