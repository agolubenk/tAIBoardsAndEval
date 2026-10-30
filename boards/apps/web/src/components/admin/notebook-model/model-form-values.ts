import type { NotebookModelSettings } from "@/fetchers/admin/get-notebook-model";
import type { NotebookModelPatch } from "@/fetchers/admin/update-notebook-model";

export type ModelFormValues = {
  baseUrl: string;
  model: string;
  embedModel: string;
  dailyMax: string;
};

const TEXT_FIELDS = ["baseUrl", "model", "embedModel"] as const;

export function toModelFormValues(
  settings: Pick<
    NotebookModelSettings,
    "baseUrl" | "model" | "embedModel" | "dailyMax"
  >,
): ModelFormValues {
  return {
    baseUrl: settings.baseUrl,
    model: settings.model ?? "",
    embedModel: settings.embedModel,
    dailyMax: String(settings.dailyMax),
  };
}

// Only the fields the admin changed are sent, so a value that still comes
// from the server's environment stays there. An emptied field goes back to
// the server's default.
export function toModelPatch(
  values: ModelFormValues,
  current: ModelFormValues,
): NotebookModelPatch {
  const patch: NotebookModelPatch = {};
  for (const field of TEXT_FIELDS) {
    const value = values[field].trim();
    if (value === current[field].trim()) continue;
    patch[field] = value === "" ? null : value;
  }
  const dailyMax = values.dailyMax.trim();
  if (dailyMax !== current.dailyMax.trim()) {
    patch.dailyMax = dailyMax === "" ? null : Number(dailyMax);
  }
  return patch;
}
