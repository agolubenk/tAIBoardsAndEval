import type { NotebookModelPatch } from "@/fetchers/admin/update-notebook-model";
import { HttpError } from "@/lib/http-error";

// The API refuses a save with 409 in two cases, told apart by what was sent:
// a new key the server cannot seal, or a new address for a key sealed to the
// old one.
export function notebookModelSaveError(
  error: unknown,
  patch: NotebookModelPatch,
) {
  if (!(error instanceof HttpError) || error.status !== 409) {
    return "settings:adminNotebookModel.toast.saveError" as const;
  }
  return typeof patch.key === "string"
    ? ("settings:adminNotebookModel.toast.noEncryptionKey" as const)
    : ("settings:adminNotebookModel.toast.keyForOldAddress" as const);
}
