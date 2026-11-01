import { ChevronRight, Undo2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type getCardHistory from "@/fetchers/forest/get-card-history";
import { cn } from "@/lib/cn";
import { formatChangeValue } from "@/lib/forest/format-change-value";
import {
  formatDateShort,
  formatDateTime,
  formatRelativeTime,
} from "@/lib/format";

type HistoryEntry = Awaited<
  ReturnType<typeof getCardHistory>
>["entries"][number];

type CardHistoryItemProps = {
  entry: HistoryEntry;
  fieldLabels: Record<string, string>;
  actorLabel: string;
  rollingBack: boolean;
  onRollback: () => void;
};

// One edit: when, who, which fields; open it to see the values, undo it with
// a second click so a stray one changes nothing.
export function CardHistoryItem({
  entry,
  fieldLabels,
  actorLabel,
  rollingBack,
  onRollback,
}: CardHistoryItemProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const fields = Object.keys(entry.changes);
  const show = (value: unknown) =>
    formatChangeValue(value, (iso) => formatDateShort(iso)) ?? "—";

  return (
    <li className="flex flex-col rounded-md hover:bg-accent/40">
      <div className="flex min-w-0 items-start gap-1">
        <button
          type="button"
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-start gap-1.5 px-2 py-1.5 text-left"
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate font-medium text-[13px] text-foreground">
              {fields.map((field) => fieldLabels[field] ?? field).join(", ")}
            </span>
            <span className="truncate text-muted-foreground text-xs">
              <span title={formatDateTime(entry.createdAt)}>
                {formatRelativeTime(entry.createdAt)}
              </span>
              {" · "}
              {actorLabel}
            </span>
          </span>
        </button>
        {confirming ? (
          <Button
            size="xs"
            variant="destructive"
            className="mt-1 mr-1"
            disabled={rollingBack}
            onClick={onRollback}
            onBlur={() => setConfirming(false)}
          >
            {t("tasks:card.history.confirmUndo")}
          </Button>
        ) : (
          <Button
            size="icon-xs"
            variant="ghost"
            className="mt-1 mr-1"
            aria-label={t("tasks:card.history.undo")}
            title={t("tasks:card.history.undo")}
            onClick={() => setConfirming(true)}
          >
            <Undo2 aria-hidden="true" />
          </Button>
        )}
      </div>
      {open ? (
        <dl className="flex flex-col gap-1.5 px-2 pb-2 pl-7">
          {fields.map((field) => (
            <div key={field} className="flex flex-col gap-0.5 text-xs">
              <dt className="text-muted-foreground">
                {fieldLabels[field] ?? field}
              </dt>
              <dd className="break-words">
                <span className="text-muted-foreground line-through">
                  {show(entry.changes[field]?.from)}
                </span>
                <span className="px-1 text-muted-foreground">→</span>
                <span className="text-foreground">
                  {show(entry.changes[field]?.to)}
                </span>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </li>
  );
}
