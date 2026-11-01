import { normalizeBaseUrl, urlOrigin } from "../notebook/llm/base-url";
import { notebookLlmConfig, readLlmKey } from "../notebook/llm/llm-config";
import { envEmbedModel } from "../notebook/notebook-config";
import { readStoredNotebookModel } from "./notebook-model-store";
import { openSecret } from "./secret-box";

export type NotebookModel = {
  baseUrl: string;
  model: string | null;
  embedModel: string;
  dailyMax: number;
  key: string | null;
  // Where the key came from; "settings" wins over the server's key file.
  keySource: "settings" | "file" | null;
  // A key is stored but cannot be opened: the server's settings key or the
  // API address changed since it was saved.
  keyUnreadable: boolean;
  // The server's key file holds a key for the server's own address, and the
  // admin's address differs, so the file key is not sent there.
  fileKeyWithheld: boolean;
  // GLM's reasoning switch (`NOTEBOOK_LLM_THINKING`). Like the key file it is
  // set for the server's own address and is not sent to another one.
  thinking: string | null;
};

// The admin's settings first, then the server's environment, then defaults.
export async function effectiveNotebookModel(): Promise<NotebookModel> {
  const stored = await readStoredNotebookModel();
  const env = notebookLlmConfig();
  const baseUrl = stored.baseUrl
    ? normalizeBaseUrl(stored.baseUrl)
    : env.baseUrl;
  const origin = urlOrigin(baseUrl);
  const storedKey = stored.key ? openSecret(stored.key, origin) : null;
  const fileFits = origin === urlOrigin(env.baseUrl);
  const fileKey = storedKey ? null : readLlmKey(env.keyFile);
  const usedFileKey = fileFits ? fileKey : null;
  return {
    baseUrl,
    model: stored.model ?? env.model,
    embedModel: stored.embedModel ?? envEmbedModel(),
    dailyMax: stored.dailyMax ?? env.dailyMax,
    key: storedKey ?? usedFileKey,
    keySource: storedKey ? "settings" : usedFileKey ? "file" : null,
    keyUnreadable: Boolean(stored.key) && !storedKey,
    fileKeyWithheld: fileKey !== null && !fileFits,
    thinking: fileFits ? (env.thinking ?? null) : null,
  };
}

export async function notebookEmbedModel(): Promise<string> {
  return (await readStoredNotebookModel()).embedModel ?? envEmbedModel();
}
