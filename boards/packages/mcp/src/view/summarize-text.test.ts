import { describe, expect, it } from "vite-plus/test";
import { SUMMARY_CHARS, summarizeText } from "./summarize-text.js";

describe("summarizeText", () => {
  it("keeps the first paragraph of long text fields", () => {
    const value = [
      { id: "t1", description: "First part.\n\nSecond part.", title: "a\n\nb" },
    ];

    expect(summarizeText(value)).toEqual([
      { id: "t1", description: "First part.…", title: "a\n\nb" },
    ]);
  });

  it("cuts a long paragraph", () => {
    const result = summarizeText({ body: "x".repeat(SUMMARY_CHARS * 2) }) as {
      body: string;
    };

    expect(result.body).toHaveLength(SUMMARY_CHARS + 1);
    expect(result.body.endsWith("…")).toBe(true);
  });

  it("leaves short text alone", () => {
    expect(summarizeText({ comment: "Done." })).toEqual({ comment: "Done." });
  });
});
