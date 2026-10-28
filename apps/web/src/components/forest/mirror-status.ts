import type { ComponentProps } from "react";
import type { Badge } from "@/components/ui/badge";
import type { ForestMirrorRun } from "./forest-types";

export const MIRROR_STATUS_VARIANT: Record<
  ForestMirrorRun["status"],
  NonNullable<ComponentProps<typeof Badge>["variant"]>
> = {
  running: "info",
  clean: "success",
  discrepancies: "warning",
  failed: "error",
};
