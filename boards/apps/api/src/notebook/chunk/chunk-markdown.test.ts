import { describe, expect, it } from "vite-plus/test";
import { chunkMarkdown } from "./chunk-markdown";

describe("chunkMarkdown", () => {
  it("keeps the heading path on every chunk", () => {
    const chunks = chunkMarkdown(
      "Intro line\n\n# Spec\n\nTop.\n\n## Data\n\nRows.\n\n### Tables\n\nColumns.\n\n## API\n\nRoutes.",
    );
    expect(chunks).toEqual([
      { heading: "", text: "Intro line" },
      { heading: "Spec", text: "Top." },
      { heading: "Spec › Data", text: "Rows." },
      { heading: "Spec › Data › Tables", text: "Columns." },
      { heading: "Spec › API", text: "Routes." },
    ]);
  });

  it("does not read a heading inside a code fence", () => {
    const chunks = chunkMarkdown(
      "# Run\n\n```sh\n# not a heading\n\necho ok\n```\n\nAfter.",
    );
    expect(chunks).toEqual([
      {
        heading: "Run",
        text: "```sh\n# not a heading\n\necho ok\n```\n\nAfter.",
      },
    ]);
  });

  it("packs paragraphs up to the limit and splits an oversized one", () => {
    const paragraph = "a".repeat(40);
    const chunks = chunkMarkdown(
      `# S\n\n${paragraph}\n\n${paragraph}\n\n${paragraph}\n\n${"b".repeat(130)}`,
      100,
    );
    expect(chunks.map(({ text }) => text.length)).toEqual([82, 40, 100, 30]);
    expect(chunks.every(({ heading }) => heading === "S")).toBe(true);
    expect(chunks.every(({ text }) => text.length <= 100)).toBe(true);
  });

  it("drops empty sections and normalises line endings", () => {
    expect(chunkMarkdown("# Empty\r\n\r\n# Full\r\nText\r\n")).toEqual([
      { heading: "Full", text: "Text" },
    ]);
    expect(chunkMarkdown("")).toEqual([]);
  });
});
