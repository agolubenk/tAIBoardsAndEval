import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/cn";

type ForestTaskLinkProps = {
  workspaceId: string;
  projectId: string;
  taskId: string;
  number: number | null;
  title: string;
  className?: string;
};

export function ForestTaskLink({
  workspaceId,
  projectId,
  taskId,
  number,
  title,
  className,
}: ForestTaskLinkProps) {
  return (
    <Link
      to="/dashboard/workspace/$workspaceId/project/$projectId/task/$taskId"
      params={{ workspaceId, projectId, taskId }}
      className={cn(
        "min-w-0 truncate rounded-sm text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {number !== null ? (
        <span className="mr-1.5 text-muted-foreground tabular-nums">
          #{number}
        </span>
      ) : null}
      {title}
    </Link>
  );
}
