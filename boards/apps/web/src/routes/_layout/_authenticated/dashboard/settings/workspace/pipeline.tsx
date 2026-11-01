import { createFileRoute } from "@tanstack/react-router";
import { PipelineSettingsPage } from "@/components/settings/workspace-pipeline/pipeline-settings-page";

export const Route = createFileRoute(
  "/_layout/_authenticated/dashboard/settings/workspace/pipeline",
)({
  component: PipelineSettingsPage,
});
