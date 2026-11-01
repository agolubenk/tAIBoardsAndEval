import { describe, expect, it } from "vite-plus/test";
import {
  defaultCounter,
  decodeResponse,
  encodeResponse,
  fitToBudget,
} from "./index";

function roundTrip(value: unknown, format: "toon" | "json" = "toon") {
  const encoded = encodeResponse(value, { format });
  expect(encoded.format).toBe(format);
  expect(encoded.fallbackError).toBeUndefined();
  return decodeResponse(encoded.text, format);
}

describe("@kaneo/agent-format", () => {
  describe("round-trip (AC-022)", () => {
    it("handles Unicode, Cyrillic and emoji", () => {
      const value = {
        title: "Карточка «Собеседование» 🎯",
        note: "привет мир — 你好 — مرحبا 🚀✨",
      };
      expect(roundTrip(value)).toEqual(value);
    });

    it("distinguishes empty strings, null and missing keys", () => {
      const withNull = roundTrip({ a: "", b: null }) as Record<string, unknown>;
      expect(withNull.a).toBe("");
      expect(withNull.b).toBeNull();
      expect(Object.keys(withNull).sort()).toEqual(["a", "b"]);

      const missing = roundTrip({ a: "" }) as Record<string, unknown>;
      expect("b" in missing).toBe(false);
    });

    it("round-trips nesting of at least 4 levels", () => {
      const value = {
        l1: { l2: { l3: { l4: { l5: { deep: "значение" } } } } },
      };
      expect(roundTrip(value)).toEqual(value);
    });

    it("round-trips homogeneous arrays in TOON table form", () => {
      const value = {
        tasks: [
          { id: 1, title: "Первая", done: true },
          { id: 2, title: "Вторая", done: false },
          { id: 3, title: "Третья", done: true },
        ],
      };
      const encoded = encodeResponse(value);
      expect(encoded.text).toContain("tasks[3]{");
      expect(roundTrip(value)).toEqual(value);
    });

    it("round-trips heterogeneous arrays", () => {
      const value = { mixed: [1, "два", null, true, { k: "v" }, [1, 2]] };
      expect(roundTrip(value)).toEqual(value);
    });

    it("round-trips Markdown with tables, code, pipes, colons and commas", () => {
      const markdown = [
        "# Отчёт",
        "",
        "| col: a | col, b |",
        "| --- | --- |",
        "| 1 | 2 |",
        "",
        "```ts",
        "const x: number = 1; // pipe | inside",
        "```",
        "",
        "Строка с | трубой, и: двоеточием, и запятой.",
      ].join("\n");
      const value = { report: markdown };
      expect(roundTrip(value)).toEqual(value);
    });

    it("round-trips through JSON format identically", () => {
      const value = { a: [1, { b: "два" }], c: null };
      expect(roundTrip(value, "json")).toEqual(value);
    });
  });

  describe("fitToBudget", () => {
    it("returns fitting values untouched with truncated=false", () => {
      const value = { id: "T-1", title: "Маленькая карточка" };
      const result = fitToBudget(value, { fullRef: "t-boards://card/T-1" });
      expect(result.truncated).toBe(false);
      expect(result.text).not.toContain("fullRef");
      expect(result.tokens).toBe(defaultCounter.count(result.text));
    });

    it("truncates structurally, stays valid TOON and carries fullRef", () => {
      const value = {
        id: "T-2",
        description: `длинное описание. `.repeat(2000),
        comments: Array.from({ length: 200 }, (_, i) => ({
          author: `user-${i}`,
          body: `комментарий ${i} с каким-то текстом`,
        })),
      };
      const result = fitToBudget(value, {
        budget: 400,
        fullRef: "t-boards://card/T-2",
      });
      expect(result.truncated).toBe(true);
      expect(result.tokens).toBeLessThanOrEqual(400);
      expect(result.text).toContain("t-boards://card/T-2");
      const decoded = decodeResponse(result.text, result.format) as Record<
        string,
        unknown
      >;
      expect(decoded.truncated).toBe(true);
      expect(decoded.fullRef).toBe("t-boards://card/T-2");
    });

    it("clamps the budget into the 150–2500 corridor", () => {
      const value = { description: "текст ".repeat(500) };
      const high = fitToBudget(value, {
        budget: 100_000,
        fullRef: "ref://x",
      });
      expect(high.tokens).toBeLessThanOrEqual(2500);
    });

    it("shortens long strings before trimming array tails", () => {
      const value = {
        description: "описание ".repeat(500),
        items: Array.from({ length: 10 }, (_, i) => `item-${i}`),
      };
      const result = fitToBudget(value, {
        budget: 250,
        fullRef: "ref://y",
      });
      expect(result.tokens).toBeLessThanOrEqual(250);
      const decoded = decodeResponse(result.text, result.format) as {
        description: string;
        items: string[];
      };
      // Progressive halving keeps as much text as fits the budget: the
      // string absorbs the truncation (~4x shorter than the 4500-char
      // original) and the array stays untouched.
      expect(decoded.description.length).toBeLessThanOrEqual(1500);
      expect(decoded.items).toHaveLength(10);
    });

    it("respects a custom TokenCounter", () => {
      const chars: { name: string; count(text: string): number } = {
        name: "chars",
        count: (text) => text.length,
      };
      const value = { description: "x".repeat(10_000) };
      const result = fitToBudget(value, {
        budget: 600,
        fullRef: "ref://z",
        counter: chars,
      });
      expect(result.tokens).toBeLessThanOrEqual(600);
    });
  });
});
