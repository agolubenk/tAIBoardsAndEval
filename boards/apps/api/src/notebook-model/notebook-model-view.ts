import { cloudCallsToday } from "../notebook/chat/call-budget";
import { effectiveNotebookModel } from "./effective-notebook-model";
import { canSealSecrets } from "./secret-box";
import { usageByWorkspace } from "./usage-by-workspace";

export async function notebookModelView() {
  const [settings, callsToday, usage] = await Promise.all([
    effectiveNotebookModel(),
    cloudCallsToday(),
    usageByWorkspace(),
  ]);
  return {
    baseUrl: settings.baseUrl,
    model: settings.model,
    embedModel: settings.embedModel,
    dailyMax: settings.dailyMax,
    hasKey: settings.key !== null,
    keySource: settings.keySource,
    keyUnreadable: settings.keyUnreadable,
    fileKeyWithheld: settings.fileKeyWithheld,
    canStoreKey: canSealSecrets(),
    callsToday,
    usage,
  };
}
