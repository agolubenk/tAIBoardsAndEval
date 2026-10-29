import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

type PulseSectionProps = {
  title: string;
  count?: number;
  action?: { label: string; onClick: () => void };
  children: ReactNode;
};

// One block of the «what is on fire» panel: a heading, a count and a way to
// the tab that holds the whole list.
export function PulseSection({
  title,
  count,
  action,
  children,
}: PulseSectionProps) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-medium text-sm">{title}</h2>
        {count ? (
          <span className="rounded-full bg-muted px-1.5 text-muted-foreground text-xs tabular-nums">
            {count}
          </span>
        ) : null}
        {action ? (
          <Button
            size="xs"
            variant="ghost"
            className="ms-auto"
            onClick={action.onClick}
          >
            {action.label}
          </Button>
        ) : null}
      </div>
      {children}
    </section>
  );
}
