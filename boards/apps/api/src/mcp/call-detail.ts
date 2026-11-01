import type { ToolCall } from "@kaneo/mcp/tools";
import { redact } from "@kaneo/redact";

// The journal keeps 2000 characters of detail. The arguments go last, cut
// here, so the sizes always survive and the JSON stays whole.
const ARGS_MAX = 1500;

// Quotes and backslashes double when the arguments are escaped again inside
// the detail, so the cut is measured on the escaped text.
function cut(text: string) {
  if (JSON.stringify(text).length <= ARGS_MAX) return text;
  let kept = text.slice(0, ARGS_MAX);
  for (;;) {
    const over = JSON.stringify(`${kept}…`).length - ARGS_MAX;
    if (over <= 0) return `${kept}…`;
    kept = kept.slice(0, kept.length - over);
  }
}

// R-036: what an MCP call journals. Secrets in the arguments are replaced by
// a label before the row is written and before the cut, so a cut never splits
// a secret past the detector (D-011).
export function callDetail(call: ToolCall) {
  const args = cut(redact(JSON.stringify(call.args ?? null)).text);
  return JSON.stringify({
    bytes: call.bytes,
    tokens: call.tokens,
    ms: call.ms,
    args,
  });
}
