import { HTTPException } from "hono/http-exception";
import {
  readStoredNotebookModel,
  type StoredNotebookModel,
  writeStoredNotebookModel,
} from "./notebook-model-store";
import type { UpdateNotebookModel } from "./schema";
import { canSealSecrets, sealSecret } from "./secret-box";

// A field left out keeps its value; null clears it back to the server's
// default. The key is sealed before it reaches the database.
export async function updateNotebookModel(
  patch: UpdateNotebookModel,
  actorId: string,
) {
  if (typeof patch.key === "string" && !canSealSecrets()) {
    throw new HTTPException(409, {
      message:
        "The server has no settings encryption key, so a model key cannot be stored",
    });
  }
  const next: StoredNotebookModel = { ...(await readStoredNotebookModel()) };
  for (const field of ["baseUrl", "model", "embedModel", "dailyMax"] as const) {
    const value = patch[field];
    if (value === undefined) continue;
    if (value === null) delete next[field];
    else (next as Record<string, unknown>)[field] = value;
  }
  if (patch.key === null) delete next.key;
  else if (patch.key !== undefined) next.key = sealSecret(patch.key);
  await writeStoredNotebookModel(next, actorId);
}
