import { describe, expect, it } from "vite-plus/test";
import { HttpError } from "@/lib/http-error";
import { notebookModelSaveError } from "./notebook-model-save-error";

describe("notebookModelSaveError", () => {
  it("names a key the server cannot store", () => {
    expect(
      notebookModelSaveError(new HttpError(409, "x"), { key: "sk-test" }),
    ).toBe("settings:adminNotebookModel.toast.noEncryptionKey");
  });

  it("names a key sealed to the previous address", () => {
    expect(
      notebookModelSaveError(new HttpError(409, "x"), {
        baseUrl: "https://gw.example/v1",
      }),
    ).toBe("settings:adminNotebookModel.toast.keyForOldAddress");
  });

  it("falls back to the general message", () => {
    expect(notebookModelSaveError(new HttpError(400, "x"), {})).toBe(
      "settings:adminNotebookModel.toast.saveError",
    );
    expect(notebookModelSaveError(new Error("offline"), {})).toBe(
      "settings:adminNotebookModel.toast.saveError",
    );
  });
});
