import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";

const CLAMP_FROM = 160;

// Report and context pack: a few lines, the rest on request.
export function CardLongText({ text }: { text: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const long = text.length > CLAMP_FROM;

  return (
    <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5 px-2 py-1.5">
      <p
        className={cn(
          "whitespace-pre-wrap break-words text-[13px] text-foreground",
          long && !open && "line-clamp-3",
        )}
      >
        {text}
      </p>
      {long ? (
        <button
          type="button"
          className="text-muted-foreground text-xs underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? t("tasks:card.showLess") : t("tasks:card.showMore")}
        </button>
      ) : null}
    </div>
  );
}
