import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

export type NotebookModelPatch = {
  baseUrl?: string | null;
  model?: string | null;
  embedModel?: string | null;
  dailyMax?: number | null;
  key?: string | null;
};

export async function updateNotebookModel(patch: NotebookModelPatch) {
  const response = await client.admin["notebook-model"].$put({ json: patch });
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}
