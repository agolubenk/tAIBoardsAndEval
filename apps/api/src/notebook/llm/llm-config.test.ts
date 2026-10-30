import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_DAILY_MAX,
  notebookLlmConfig,
} from "./llm-config";

function configWith(env: Record<string, string>) {
  vi.stubEnv("NOTEBOOK_LLM_MODEL", "m");
  vi.stubEnv("NOTEBOOK_LLM_KEY_FILE", "/run/key");
  vi.stubEnv("NOTEBOOK_LLM_BASE_URL", "");
  vi.stubEnv("NOTEBOOK_LLM_DAILY_MAX", "");
  vi.stubEnv("NOTEBOOK_LLM_THINKING", "");
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return notebookLlmConfig();
}

describe("notebook LLM config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is off without a model or a key file", () => {
    expect(configWith({ NOTEBOOK_LLM_MODEL: " " })).toBeNull();
    expect(configWith({ NOTEBOOK_LLM_KEY_FILE: "" })).toBeNull();
  });

  // compose writes unset variables as empty strings.
  it("reads empty values as unset", () => {
    expect(configWith({})).toEqual({
      baseUrl: DEFAULT_LLM_BASE_URL,
      model: "m",
      keyFile: "/run/key",
      dailyMax: DEFAULT_LLM_DAILY_MAX,
    });
  });

  it.each([
    ["12", 12],
    [" 7 ", 7],
    ["0", 0],
    ["-1", DEFAULT_LLM_DAILY_MAX],
    ["1.5", DEFAULT_LLM_DAILY_MAX],
    ["many", DEFAULT_LLM_DAILY_MAX],
  ])("takes a daily max of %j as %d", (raw, expected) => {
    expect(configWith({ NOTEBOOK_LLM_DAILY_MAX: raw })?.dailyMax).toBe(
      expected,
    );
  });

  it("passes a thinking mode through and leaves it out when unset", () => {
    expect(configWith({ NOTEBOOK_LLM_THINKING: " disabled " })?.thinking).toBe(
      "disabled",
    );
    expect(configWith({ NOTEBOOK_LLM_THINKING: " " })).not.toHaveProperty(
      "thinking",
    );
  });

  it("drops trailing slashes from the base URL", () => {
    expect(
      configWith({ NOTEBOOK_LLM_BASE_URL: "http://gw:8080/v1//" })?.baseUrl,
    ).toBe("http://gw:8080/v1");
  });
});
