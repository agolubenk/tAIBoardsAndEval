import {
  defaultCounter,
  encodeResponse,
  type TokenCounter,
  type WireFormat,
} from "./wire-format.js";

export const BUDGET_MIN = 150;
export const BUDGET_MAX = 2500;
const MIN_STRING = 80;
const MAX_ROUNDS = 60;

type Slot = {
  parent: Record<string, unknown> | unknown[];
  key: string | number;
};

// The biggest string or list in the value: shrinking it saves the most. The
// last pass (`listsOnly`) drops whole items of lists down to one: ids and
// short values are never cut, a budget is still a cap.
function largestSlot(root: unknown, listsOnly = false): Slot | null {
  let best: { slot: Slot; size: number } | null = null;
  const minItems = listsOnly ? 1 : 2;
  const visit = (node: unknown, slot: Slot | null) => {
    if (typeof node === "string") {
      if (
        !listsOnly &&
        slot &&
        node.length > MIN_STRING &&
        node.length > (best?.size ?? 0)
      ) {
        best = { slot, size: node.length };
      }
      return;
    }
    if (Array.isArray(node)) {
      const size = JSON.stringify(node).length;
      if (slot && node.length >= minItems && size > (best?.size ?? 0)) {
        best = { slot, size };
      }
      node.forEach((child, index) =>
        visit(child, { parent: node, key: index }),
      );
      return;
    }
    if (node && typeof node === "object") {
      const record = node as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        visit(record[key], { parent: record, key });
      }
    }
  };
  visit(root, null);
  return (best as { slot: Slot } | null)?.slot ?? null;
}

const half = (length: number) => (length > 1 ? Math.ceil(length / 2) : 0);

function shrink(slot: Slot) {
  const container = slot.parent as Record<string | number, unknown>;
  const current = container[slot.key];
  container[slot.key] =
    typeof current === "string"
      ? `${current.slice(0, Math.ceil(current.length / 2))}…`
      : (current as unknown[]).slice(0, half((current as unknown[]).length));
}

function markTruncated(value: unknown, fullRef: string) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>), truncated: true, fullRef }
    : { truncated: true, fullRef, value };
}

// Halves the largest string or list until the answer fits (R-032). The cut
// answer says so and points at the full one.
export function fitToBudget(
  value: unknown,
  opts: {
    budget?: number;
    format?: WireFormat;
    fullRef: string;
    counter?: TokenCounter;
  },
): {
  text: string;
  format: WireFormat;
  tokens: number;
  truncated: boolean;
  fallbackError?: string;
} {
  const counter = opts.counter ?? defaultCounter;
  const budget = Math.min(
    BUDGET_MAX,
    Math.max(BUDGET_MIN, opts.budget ?? BUDGET_MAX),
  );
  let format = opts.format;
  const measure = (candidate: unknown) => {
    const encoded = encodeResponse(candidate, { format, counter });
    return {
      ...encoded,
      tokens: encoded.tokens ?? counter.count(encoded.text),
    };
  };

  const whole = measure(value);
  if (whole.tokens <= budget) return { ...whole, truncated: false };
  // The whole answer picked the wire; shrinking keeps it, encoding once a round.
  format = whole.format;

  // Marked first, so a bare list sits under `value` and can shrink too.
  const working = markTruncated(structuredClone(value), opts.fullRef);
  let attempt = measure(working);
  for (let round = 0; round < MAX_ROUNDS && attempt.tokens > budget; round++) {
    const slot = largestSlot(working) ?? largestSlot(working, true);
    if (!slot) break;
    shrink(slot);
    attempt = measure(working);
  }
  return { ...attempt, truncated: true };
}
