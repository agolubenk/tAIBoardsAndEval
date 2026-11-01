import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type CardValueProps = {
  children?: ReactNode;
  className?: string;
};

// A read-only value in a property row; an empty one shows a dash.
export function CardValue({ children, className }: CardValueProps) {
  const empty = children === null || children === undefined || children === "";
  return (
    <div
      className={cn(
        "flex min-h-7.5 min-w-0 flex-1 items-center gap-2 px-2 font-medium text-[13px] [&_svg]:size-3.5 [&_svg]:shrink-0",
        empty ? "text-muted-foreground/60" : "text-foreground",
        className,
      )}
    >
      {empty ? "—" : children}
    </div>
  );
}
