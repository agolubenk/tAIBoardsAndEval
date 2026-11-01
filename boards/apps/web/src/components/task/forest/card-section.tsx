import type { ReactNode } from "react";

type CardSectionProps = {
  title: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
};

export function CardSection({
  title,
  count,
  action,
  children,
}: CardSectionProps) {
  return (
    <section
      aria-label={title}
      className="flex flex-col gap-0.5 border-border/60 border-t pt-3"
    >
      <div className="flex h-7 items-center justify-between gap-2 pl-2">
        <h3 className="flex items-center gap-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
          {title}
          {count ? (
            <span className="rounded-full bg-muted px-1.5 text-[10px] text-foreground tabular-nums">
              {count}
            </span>
          ) : null}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}
