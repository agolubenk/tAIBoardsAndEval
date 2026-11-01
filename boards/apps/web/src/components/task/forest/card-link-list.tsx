import { useState } from "react";
import { useTranslation } from "react-i18next";
import { getExternalWebUrl } from "@/lib/external-url";

const SHOWN = 3;

const shortLabel = (value: string) => {
  const pull = value.match(/\/(?:pull|merge_requests)\/(\d+)/);
  return pull ? `#${pull[1]}` : value;
};

// Pull requests and touched files: links when they are web URLs, plain text
// otherwise; the first few, the rest on request.
export function CardLinkList({ items }: { items: string[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const shown = open ? items : items.slice(0, SHOWN);

  return (
    <ul className="flex min-w-0 flex-1 flex-col gap-0.5 px-2 py-1.5">
      {shown.map((item) => {
        const href = getExternalWebUrl(item);
        return (
          <li key={item} className="min-w-0 truncate text-[13px]" title={item}>
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-foreground hover:underline"
              >
                {shortLabel(item)}
              </a>
            ) : (
              <span className="font-mono text-foreground text-xs">{item}</span>
            )}
          </li>
        );
      })}
      {items.length > SHOWN ? (
        <li>
          <button
            type="button"
            className="text-muted-foreground text-xs underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => setOpen((value) => !value)}
          >
            {open
              ? t("tasks:card.showLess")
              : t("tasks:card.showAll", { total: items.length })}
          </button>
        </li>
      ) : null}
    </ul>
  );
}
