import {
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_DAILY_MAX,
  notebookLlmConfig,
  readLlmKey,
} from "../notebook/llm/llm-config";
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
  // A key is stored but the server's settings key cannot open it.
  keyUnreadable: boolean;
};

// The admin's settings first, then the server's environment, then defaults.
export async function effectiveNotebookModel(): Promise<NotebookModel> {
  const stored = await readStoredNotebookModel();
  const env = notebookLlmConfig();
  const storedKey = stored.key ? openSecret(stored.key) : null;
  const fileKey = storedKey || !env ? null : readLlmKey(env);
  return {
    baseUrl: stored.baseUrl ?? env?.baseUrl ?? DEFAULT_LLM_BASE_URL,
    model: stored.model ?? env?.model ?? null,
    embedModel: stored.embedModel ?? envEmbedModel(),
    dailyMax: stored.dailyMax ?? env?.dailyMax ?? DEFAULT_LLM_DAILY_MAX,
    key: storedKey ?? fileKey,
    keySource: storedKey ? "settings" : fileKey ? "file" : null,
    keyUnreadable: Boolean(stored.key) && !storedKey,
  };
}

export async function notebookEmbedModel(): Promise<string> {
  return (await readStoredNotebookModel()).embedModel ?? envEmbedModel();
}
