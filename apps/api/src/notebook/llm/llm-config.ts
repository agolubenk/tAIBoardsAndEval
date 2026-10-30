import { readFileSync } from "node:fs";
import { normalizeBaseUrl } from "./base-url";

// Any OpenAI-compatible endpoint; the spec's choice is free NVIDIA models
// through OpenRouter (R-052). Without a model or a key the notebook still
// answers with the sources it found, it only skips the written answer. This is
// the server's environment; the admin's settings override it (TB-67).
export const DEFAULT_LLM_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_LLM_DAILY_MAX = 500;

export type LlmConfig = {
  baseUrl: string;
  model: string | null;
  keyFile: string | null;
  dailyMax: number;
};

// Each value stands on its own: the key file and the limit still apply when
// the model comes from the admin's settings.
export function notebookLlmConfig(): LlmConfig {
  // compose passes an unset variable as "", and Number("") is 0: every call
  // would be capped. Only a written number counts; "0" turns calls off.
  const rawMax = process.env.NOTEBOOK_LLM_DAILY_MAX?.trim();
  const dailyMax = rawMax ? Number(rawMax) : Number.NaN;
  return {
    baseUrl: normalizeBaseUrl(
      process.env.NOTEBOOK_LLM_BASE_URL?.trim() || DEFAULT_LLM_BASE_URL,
    ),
    model: process.env.NOTEBOOK_LLM_MODEL?.trim() || null,
    keyFile: process.env.NOTEBOOK_LLM_KEY_FILE?.trim() || null,
    dailyMax:
      Number.isInteger(dailyMax) && dailyMax >= 0
        ? dailyMax
        : DEFAULT_LLM_DAILY_MAX,
  };
}

// Read on every call, so a rotated key needs no restart (N-007: files only).
export function readLlmKey(keyFile: string | null): string | null {
  if (!keyFile) return null;
  try {
    return readFileSync(keyFile, "utf8").trim() || null;
  } catch {
    return null;
  }
}
