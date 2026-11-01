import type { NotebookSourceKind } from "./notebook-types";

type SourceLabelProps = {
  kind: NotebookSourceKind;
  ref_: string;
  title: string;
  heading?: string;
};

// Title, the heading path inside it and the ref. A link source opens in a new
// tab; repo paths and card ids are shown as text.
export function SourceLabel({ kind, ref_, title, heading }: SourceLabelProps) {
  const isLink = kind === "link" && ref_.startsWith("https://");

  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate font-medium text-sm">
        {title}
        {heading && heading !== title ? (
          <span className="font-normal text-muted-foreground">
            {" › "}
            {heading}
          </span>
        ) : null}
      </span>
      {isLink ? (
        <a
          href={ref_}
          target="_blank"
          rel="noopener noreferrer"
          className="truncate text-muted-foreground text-xs underline-offset-2 hover:underline"
        >
          {ref_}
        </a>
      ) : (
        <span className="truncate font-mono text-muted-foreground text-xs">
          {ref_}
        </span>
      )}
    </span>
  );
}
