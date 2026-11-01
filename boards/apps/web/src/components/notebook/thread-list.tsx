import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/cn";
import type { NotebookThreadSummary } from "./notebook-types";

type ThreadListProps = {
  threads: NotebookThreadSummary[];
  activeId?: string;
  onSelect: (threadId: string) => void;
};

export function ThreadList({ threads, activeId, onSelect }: ThreadListProps) {
  return (
    <ul className="flex flex-col gap-0.5">
      {threads.map((thread) => (
        <li key={thread.id}>
          <button
            type="button"
            aria-current={thread.id === activeId ? "true" : undefined}
            onClick={() => onSelect(thread.id)}
            className={cn(
              "flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left hover:bg-accent",
              thread.id === activeId && "bg-accent",
            )}
          >
            <span className="w-full truncate text-sm">{thread.title}</span>
            <span className="text-muted-foreground text-xs">
              {formatDateTime(thread.updatedAt)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
