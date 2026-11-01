import { describe, expect, it } from "vite-plus/test";
import { decodeResponse } from "@kaneo/agent-format";
import { BUDGET_MIN, fitToBudget } from "./fit-to-budget.js";
import { defaultCounter } from "./wire-format.js";

describe("fitToBudget", () => {
  it("returns a value that fits as it is", () => {
    const fitted = fitToBudget(
      { id: "t1", title: "Short" },
      { fullRef: "get_task" },
    );

    expect(fitted.truncated).toBe(false);
    expect(decodeResponse(fitted.text, fitted.format)).toEqual({
      id: "t1",
      title: "Short",
    });
  });

  it("cuts the longest text and points at the full answer", () => {
    const value = { id: "t1", description: "word ".repeat(2000) };

    const fitted = fitToBudget(value, { budget: 200, fullRef: "get_task {}" });
    const parsed = decodeResponse(fitted.text, fitted.format) as {
      description: string;
    };

    expect(fitted.truncated).toBe(true);
    expect(fitted.tokens).toBeLessThanOrEqual(200);
    expect(defaultCounter.count(fitted.text)).toBe(fitted.tokens);
    expect(parsed).toMatchObject({
      id: "t1",
      truncated: true,
      fullRef: "get_task {}",
    });
    expect(parsed.description.endsWith("…")).toBe(true);
  });

  it("shortens a bare list under value", () => {
    const list = Array.from({ length: 300 }, (_, i) => ({
      id: `t${i}`,
      title: `Task ${i}`,
    }));

    const fitted = fitToBudget(list, { budget: 300, fullRef: "list_tasks {}" });
    const parsed = decodeResponse(fitted.text, fitted.format) as {
      truncated: boolean;
      value: unknown[];
    };

    expect(fitted.tokens).toBeLessThanOrEqual(300);
    expect(parsed.truncated).toBe(true);
    expect(parsed.value.length).toBeGreaterThan(0);
    expect(parsed.value.length).toBeLessThan(300);
    expect(parsed.value[0]).toEqual({ id: "t0", title: "Task 0" });
  });

  it("never goes below the minimum budget", () => {
    const value = { id: "t1", description: "x".repeat(400) };

    const fitted = fitToBudget(value, { budget: 10, fullRef: "get_task {}" });

    expect(fitted.truncated).toBe(false);
    expect(fitted.tokens).toBeLessThanOrEqual(BUDGET_MIN);
  });

  it("does not change the caller's value", () => {
    const value = { id: "t1", description: "word ".repeat(2000) };
    const before = JSON.stringify(value);

    fitToBudget(value, { budget: 150, fullRef: "get_task {}" });

    expect(JSON.stringify(value)).toBe(before);
  });

  it("answers TOON by default and JSON on request (R-033)", () => {
    expect(fitToBudget({ id: "t1" }, { fullRef: "x" }).format).toBe("toon");
    expect(
      fitToBudget({ id: "t1" }, { format: "json", fullRef: "x" }).format,
    ).toBe("json");
  });

  it("drops whole list items when no long text is left to cut", () => {
    // Single-item lists of short fields: nothing for the first pass to halve.
    const row = (n: number) =>
      Object.fromEntries(
        Array.from({ length: 12 }, (_, i) => [`field${i}`, `value-${n}-${i}`]),
      );
    const value = {
      id: "card-id-that-must-stay-whole",
      comments: [row(1)],
      relations: [row(2)],
      history: [row(3)],
    };

    const out = fitToBudget(value, {
      budget: 150,
      format: "json",
      fullRef: "x",
    });
    const body = JSON.parse(out.text) as Record<string, unknown[]> & {
      id: string;
    };

    expect(out.tokens).toBeLessThanOrEqual(150);
    expect(out.truncated).toBe(true);
    expect(body.id).toBe("card-id-that-must-stay-whole");
    expect(
      body.comments.length + body.relations.length + body.history.length,
    ).toBeLessThan(3);
  });
});
