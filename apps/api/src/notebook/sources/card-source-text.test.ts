import { describe, expect, it } from "vite-plus/test";
import { chunkMarkdown } from "../chunk/chunk-markdown";
import {
  CARD_TEXT_MAX,
  type CardSourceRow,
  cardSourceText,
  cardSourceTitle,
} from "./card-source-text";

const card: CardSourceRow = {
  id: "t1",
  number: 12,
  title: "Блокнот в UI",
  status: "in-progress",
  priority: "high",
  description: "Страница с чатом.\n\n## Приёмка\n\nСсылки [n] кликабельны.",
  projectSlug: "aib",
  projectName: "aiBoards&eval",
  kind: "bug",
  severity: "major",
  backlogId: "TB-001",
  halfBaked: true,
  report: "Сделано в e981589.",
};

describe("cardSourceText", () => {
  it("puts the ticket key, fields, description and report in reading order", () => {
    expect(cardSourceTitle(card)).toBe("AIB-12 Блокнот в UI");
    expect(cardSourceText(card)).toBe(
      [
        "# AIB-12 Блокнот в UI",
        "project: aiBoards&eval · status: in-progress · priority: high · kind: bug · severity: major · backlog: TB-001 · half-baked: yes",
        "Страница с чатом.\n\n## Приёмка\n\nСсылки [n] кликабельны.",
        "## Report\n\nСделано в e981589.",
      ].join("\n\n"),
    );
  });

  it("keeps the description's own headings under the card", () => {
    const headings = chunkMarkdown(cardSourceText(card)).map((c) => c.heading);
    expect(headings).toContain("AIB-12 Блокнот в UI › Приёмка");
    expect(headings).toContain("AIB-12 Блокнот в UI › Report");
  });

  it("leaves out empty parts and plain task kinds", () => {
    const text = cardSourceText({
      ...card,
      number: null,
      kind: "task",
      severity: null,
      backlogId: null,
      halfBaked: null,
      description: "  ",
      report: null,
    });
    expect(text).toBe(
      "# AIB Блокнот в UI\n\nproject: aiBoards&eval · status: in-progress · priority: high",
    );
  });

  it("caps a huge description", () => {
    const text = cardSourceText({ ...card, description: "я".repeat(200_000) });
    expect(text.length).toBe(CARD_TEXT_MAX);
  });
});
