import { withoutOutboundTelemetry } from "../../utils/sensitive-outbound";
import type { LlmConfig } from "./llm-config";

const RESPONSE_MAX_BYTES = 512 * 1024;

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type Failure = "timeout" | "http" | "network" | "response" | "rate-limited";

// Like OutboundRequestError: never carries the key, the URL or the body.
export class LlmError extends Error {
  constructor(
    readonly reason: Failure,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(`LLM call failed: ${reason}${status ? ` (HTTP ${status})` : ""}`);
  }
}

export function parseRetryAfter(
  value: string | null,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  // A number is never a date: Date.parse("-3") is the year -3.
  const seconds = Number(value);
  if (Number.isFinite(seconds))
    return seconds >= 0 ? seconds * 1000 : undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new LlmError("response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_MAX_BYTES) throw new LlmError("response");
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new LlmError("response");
  }
}

export function answerText(body: unknown): string {
  const content = (
    body as { choices?: { message?: { content?: unknown } }[] } | null
  )?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new LlmError("response");
  }
  return content.trim();
}

export async function chatCompletion(
  config: Pick<LlmConfig, "baseUrl" | "model">,
  key: string,
  messages: ChatMessage[],
  options: { timeoutMs?: number; maxTokens?: number } = {},
): Promise<string> {
  const signal = AbortSignal.timeout(options.timeoutMs ?? 60_000);
  try {
    const response = await withoutOutboundTelemetry(() =>
      fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          "x-title": "t-boards notebook",
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          max_tokens: options.maxTokens ?? 1200,
          temperature: 0.2,
        }),
      }),
    );
    if (response.status === 429) {
      void response.body?.cancel().catch(() => {});
      throw new LlmError(
        "rate-limited",
        429,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new LlmError("http", response.status);
    }
    return answerText(await readBoundedJson(response));
  } catch (error) {
    if (error instanceof LlmError) throw error;
    if (signal.aborted) throw new LlmError("timeout");
    throw new LlmError("network");
  }
}
