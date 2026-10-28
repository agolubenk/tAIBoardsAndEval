import { readFileSync } from "node:fs";

// Any OpenAI-compatible endpoint; the spec's choice is free NVIDIA models
// through OpenRouter (R-052). Without a model or a key file the notebook still
// answers with the sources it found, it only skips the written answer.
export const DEFAULT_LLM_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_LLM_DAILY_MAX = 500;

export type LlmConfig = {
  baseUrl: string;
  model: string;
  keyFile: string;
  dailyMax: number;
};

export function notebookLlmConfig(): LlmConfig | null {
  const model = process.env.NOTEBOOK_LLM_MODEL?.trim();
  const keyFile = process.env.NOTEBOOK_LLM_KEY_FILE?.trim();
  if (!model || !keyFile) return null;
  const dailyMax = Number(process.env.NOTEBOOK_LLM_DAILY_MAX);
  return {
    baseUrl: (
      process.env.NOTEBOOK_LLM_BASE_URL?.trim() || DEFAULT_LLM_BASE_URL
    ).replace(/\/+$/, ""),
    model,
    keyFile,
    dailyMax:
      Number.isInteger(dailyMax) && dailyMax >= 0
        ? dailyMax
        : DEFAULT_LLM_DAILY_MAX,
  };
}

// Read on every call, so a rotated key needs no restart (N-007: files only).
export function readLlmKey(config: LlmConfig): string | null {
  try {
    return readFileSync(config.keyFile, "utf8").trim() || null;
  } catch {
    return null;
  }
}
