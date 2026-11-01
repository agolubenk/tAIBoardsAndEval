import { describe, expect, it } from "vite-plus/test";
import { toModelFormValues, toModelPatch } from "./model-form-values";

const current = toModelFormValues({
  baseUrl: "https://openrouter.ai/api/v1",
  model: null,
  embedModel: "nomic-embed-text",
  dailyMax: 500,
});

describe("toModelPatch", () => {
  it("sends nothing when nothing changed", () => {
    expect(toModelPatch({ ...current }, current)).toEqual({});
  });

  it("sends only the changed fields, trimmed", () => {
    expect(
      toModelPatch(
        { ...current, model: "  openai/gpt-4o-mini ", dailyMax: "200" },
        current,
      ),
    ).toEqual({ model: "openai/gpt-4o-mini", dailyMax: 200 });
  });

  it("clears an emptied field back to the server default", () => {
    expect(
      toModelPatch({ ...current, embedModel: " ", dailyMax: "" }, current),
    ).toEqual({ embedModel: null, dailyMax: null });
  });
});
