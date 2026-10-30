import type { StatusTone } from "@/components/settings/status-badge";
import type { NotebookModelSettings } from "@/fetchers/admin/get-notebook-model";

export type ModelKeyStatus = "unreadable" | "settings" | "file" | "missing";

export function modelKeyStatus(
  settings: Pick<NotebookModelSettings, "keyUnreadable" | "keySource">,
): ModelKeyStatus {
  if (settings.keyUnreadable) return "unreadable";
  return settings.keySource ?? "missing";
}

export const MODEL_KEY_TONE: Record<ModelKeyStatus, StatusTone> = {
  unreadable: "destructive",
  settings: "success",
  file: "success",
  missing: "warning",
};
