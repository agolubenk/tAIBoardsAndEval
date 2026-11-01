// t-boards: TOON and the token counter come from K-3 (`@kaneo/agent-format`),
// o200k_base pinned by the package version (the D-018 proposal). JSON stays
// compact here: the package pretty-prints it, and indentation is tokens.
import {
  decodeResponse as decodeAgentFormat,
  defaultCounter,
  encodeResponse as encodeAgentFormat,
  type TokenCounter,
  type WireFormat,
} from "@kaneo/agent-format";

export { defaultCounter, type TokenCounter, type WireFormat };

type Encoded = {
  text: string;
  format: WireFormat;
  fallbackError?: string;
  tokens?: number;
};

// Without a format the answer goes out in whichever of TOON and compact JSON
// is fewer tokens (R-033 is about tokens). Measured live on 28.10: TOON wins
// on flat lists (approvals −12%) and loses on nested ones (list_tasks +19%).
export function encodeResponse(
  value: unknown,
  opts?: { format?: WireFormat; counter?: TokenCounter },
): Encoded {
  const json = JSON.stringify(value) ?? "null";
  if (opts?.format === "json") return { text: json, format: "json" };
  const toon = encodeAgentFormat(value, { format: "toon" });
  if (toon.fallbackError) {
    return { text: json, format: "json", fallbackError: toon.fallbackError };
  }
  if (opts?.format === "toon") return toon;
  const counter = opts?.counter ?? defaultCounter;
  const toonTokens = counter.count(toon.text);
  const jsonTokens = counter.count(json);
  return jsonTokens < toonTokens
    ? { text: json, format: "json", tokens: jsonTokens }
    : { text: toon.text, format: "toon", tokens: toonTokens };
}

// Reads either wire back; a TOON answer is never valid JSON except a scalar,
// which both read the same.
export function decodeWire(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return decodeAgentFormat(text, "toon");
  }
}
