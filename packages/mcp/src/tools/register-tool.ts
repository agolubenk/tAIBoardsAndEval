import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { errorResult } from "../utils/mcp-result.js";
import { shapeResult } from "../view/shape-result.js";
import { splitView, viewOptionsShape } from "../view/view-options.js";
import { defaultCounter } from "../view/wire-format.js";
import {
  agentWriteShape,
  isAgentWriteTool,
  splitAgentWrite,
  withHeaders,
} from "./agent-write.js";
import type { ToolClient, ToolRegistrar } from "./register.js";

// The callback gets the client for this call: for agent task writes it carries
// the lease and «да» headers taken out of the arguments.
export type RegisterTool = <S extends z.ZodObject>(
  name: string,
  config: { description: string; inputSchema: S },
  callback: (args: z.output<S>, client: ToolClient) => Promise<CallToolResult>,
) => unknown;

// Tools whose answer goes through the R-031 view (etag, filters, budget).
const READ_TOOLS = new Set([
  "whoami",
  "list_workspaces",
  "list_projects",
  "get_project",
  "list_tasks",
  "get_task",
  "get_task_by_ticket_id",
  "list_task_comments",
  "list_workspace_labels",
  "get_task_relations",
  "list_workspace_members",
  "search",
  "list_project_columns",
  "list_task_time_entries",
  "get_time_entry",
  "list_task_activity",
  "list_notifications",
  "forest_list_approvals",
  "forest_list_logs",
  "forest_get_log",
  "forest_list_sectors",
  "forest_get_card_meta",
  "forest_get_context",
]);

export function isReadTool(name: string) {
  return READ_TOOLS.has(name);
}

// run() keeps the API answer next to its text, so the read wrapper reshapes
// the data itself instead of parsing the text back.
const answers = new WeakMap<CallToolResult, unknown>();

export function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  return fn()
    .then((data) => {
      const result: CallToolResult = {
        content: [{ type: "text", text: JSON.stringify(data) ?? "null" }],
        isError: false,
      };
      answers.set(result, data);
      return result;
    })
    .catch((e: unknown) =>
      errorResult(e instanceof Error ? e.message : String(e)),
    );
}

// What the caller sends again, narrower, to get what a cut answer left out.
function fullRef(name: string, args: object) {
  return `${name} ${JSON.stringify(args)}`;
}

// Without a host hook a codec fallback goes to stderr: stdout is the stdio
// protocol.
export type FormatFallback = (tool: string, error: string) => void;
const logFallback: FormatFallback = (tool, error) =>
  console.error(`kaneo-mcp: ${tool} answered in JSON, TOON failed: ${error}`);

// R-036: one record per call for the host's journal. The arguments are as the
// caller sent them; the host redacts them before storing.
export type ToolCall = {
  tool: string;
  args: unknown;
  ok: boolean;
  bytes: number;
  tokens: number;
  ms: number;
};

export type RegisterHooks = {
  onFormatFallback?: FormatFallback;
  onCall?: (call: ToolCall) => void;
};

function answerText(result: CallToolResult) {
  return result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

export function createRegisterTool(
  server: ToolRegistrar,
  client: ToolClient,
  hooks: RegisterHooks = {},
): RegisterTool {
  const onFormatFallback = hooks.onFormatFallback ?? logFallback;
  const { onCall } = hooks;
  return (name, config, callback) => {
    const read = isReadTool(name);
    const agentWrite = isAgentWriteTool(name);
    const inputSchema = read
      ? config.inputSchema.extend(viewOptionsShape)
      : agentWrite
        ? config.inputSchema.extend(agentWriteShape)
        : config.inputSchema;
    const handle = async (args: unknown): Promise<CallToolResult> => {
      const parsed = inputSchema.safeParse(args);
      if (!parsed.success) return errorResult(z.prettifyError(parsed.error));
      if (agentWrite) {
        const { headers, rest } = splitAgentWrite(
          parsed.data as Record<string, unknown>,
        );
        return callback(
          rest as z.output<typeof config.inputSchema>,
          withHeaders(client, headers),
        );
      }
      if (!read)
        return callback(
          parsed.data as z.output<typeof config.inputSchema>,
          client,
        );
      const { view, rest } = splitView(parsed.data as Record<string, unknown>);
      const result = await callback(
        rest as z.output<typeof config.inputSchema>,
        client,
      );
      if (result.isError || !answers.has(result)) return result;
      return shapeResult(answers.get(result), view, fullRef(name, rest), (e) =>
        onFormatFallback(name, e),
      );
    };
    return server.registerTool(
      name,
      { ...config, inputSchema },
      async (args) => {
        if (!onCall) return handle(args);
        const started = performance.now();
        const result = await handle(args);
        const text = answerText(result);
        try {
          onCall({
            tool: name,
            args,
            ok: !result.isError,
            bytes: new TextEncoder().encode(text).length,
            tokens: defaultCounter.count(text),
            ms: Math.round(performance.now() - started),
          });
        } catch (e) {
          // The journal must not turn an answered call into a failed one.
          console.error(`kaneo-mcp: ${name} call not recorded`, e);
        }
        return result;
      },
    );
  };
}
