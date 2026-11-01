import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

export async function getPipelineSettings(workspaceId: string) {
  const response = await client["pipeline-settings"].workspace[
    ":workspaceId"
  ].$get({ param: { workspaceId } });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export type PipelineSettingsView = Awaited<
  ReturnType<typeof getPipelineSettings>
>;
