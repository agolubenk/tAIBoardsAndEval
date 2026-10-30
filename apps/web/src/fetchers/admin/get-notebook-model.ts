import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";

export async function getNotebookModel() {
  const response = await client.admin["notebook-model"].$get();
  if (!response.ok) throw await HttpError.fromResponse(response);
  return response.json();
}

export type NotebookModelSettings = Awaited<
  ReturnType<typeof getNotebookModel>
>;
