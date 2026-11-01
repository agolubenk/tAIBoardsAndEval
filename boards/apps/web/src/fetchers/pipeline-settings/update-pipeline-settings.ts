import type { PipelineToggle } from "@kaneo/permissions";
import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

export type PipelineSettingsPatch = {
  automation?: boolean;
  toggles?: Partial<Record<PipelineToggle, boolean>>;
};

export async function updatePipelineSettings(
  workspaceId: string,
  patch: PipelineSettingsPatch,
) {
  const response = await client["pipeline-settings"].workspace[
    ":workspaceId"
  ].$put({ param: { workspaceId }, json: patch });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}
