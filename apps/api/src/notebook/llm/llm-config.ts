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
  // Sent as `thinking: { type }`. GLM reasons by default and can spend the
  // whole token budget on it, leaving an empty answer; "disabled" stops that.
  // Unset sends nothing, so OpenRouter and other endpoints see no new field.
  thinking?: string;
};

export function notebookLlmConfig(): LlmConfig | null {
  const model = process.env.NOTEBOOK_LLM_MODEL?.trim();
  const keyFile = process.env.NOTEBOOK_LLM_KEY_FILE?.trim();
  if (!model || !keyFile) return null;
  // compose passes an unset variable as "", and Number("") is 0: every call
  // would be capped. Only a written number counts; "0" turns calls off.
  const rawMax = process.env.NOTEBOOK_LLM_DAILY_MAX?.trim();
  const dailyMax = rawMax ? Number(rawMax) : Number.NaN;
  const thinking = process.env.NOTEBOOK_LLM_THINKING?.trim();
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
    ...(thinking ? { thinking } : {}),
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
