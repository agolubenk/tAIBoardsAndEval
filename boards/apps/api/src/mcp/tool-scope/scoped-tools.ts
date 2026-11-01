import type { RegisterTool, ToolRegistrar } from "@kaneo/mcp/tools";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { rankTools } from "./rank-tools";
import { EXTRA_TOOLS_MAX, type McpRole, ROLE_TOOLS } from "./roles";

// One request names one need; the rest of the five stay for the next one.
const FIND_MAX = 3;

type Registration = Parameters<ToolRegistrar["registerTool"]>;
type CatalogEntry = { config: Registration[1]; callback: Registration[2] };
export type ToolCatalog = Map<string, CatalogEntry>;

export type ToolScope = {
  role: McpRole;
  // Tools this session took beyond its role on earlier requests.
  granted: readonly string[];
  grant: (tools: string[]) => Promise<string[]>;
};

// Every tool the package would register, kept instead of served, so the
// scope decides which ones the session sees.
export function collectTools(register: (registrar: ToolRegistrar) => void) {
  const catalog: ToolCatalog = new Map();
  register({
    registerTool: (name, config, callback) =>
      catalog.set(name, { config, callback }),
  });
  return catalog;
}

const answer = (value: unknown, isError = false): CallToolResult => ({
  content: [
    {
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value),
    },
  ],
  ...(isError ? { isError } : {}),
});

function schemaOf(name: string, entry: CatalogEntry) {
  return {
    name,
    description: entry.config.description,
    inputSchema: z.toJSONSchema(entry.config.inputSchema, {
      io: "input",
      unrepresentable: "any",
    }),
  };
}

const findInput = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe("The action you need, in a few English words."),
});

const callInput = z.object({
  name: z.string().trim().min(1).max(100),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

// R-034: the session lists its role's tools and the ones it took before.
// tools_find adds the nearest missing tools, at most EXTRA_TOOLS_MAX per
// session, and answers with their schemas; the catalog is never listed whole.
// tools_call reaches a taken tool for clients that keep their first list.
export function registerScoped(
  server: ToolRegistrar,
  registerTool: RegisterTool,
  catalog: ToolCatalog,
  scope: ToolScope,
) {
  const role: readonly string[] = ROLE_TOOLS[scope.role];
  const shown = new Set(
    [...role, ...scope.granted].filter((name) => catalog.has(name)),
  );
  for (const [name, entry] of catalog) {
    if (shown.has(name))
      server.registerTool(name, entry.config, entry.callback);
  }

  registerTool(
    "tools_find",
    {
      description: `Find tools this session does not list yet. Describe the action; the nearest tools are added to the session and their schemas come back. Up to ${FIND_MAX} per call, at most ${EXTRA_TOOLS_MAX} per session in total.`,
      inputSchema: findInput,
    },
    async ({ query }) => {
      const left = EXTRA_TOOLS_MAX - scope.granted.length;
      if (left <= 0) {
        return answer(
          `This session already took ${EXTRA_TOOLS_MAX} tools beyond its role: ${scope.granted.join(", ")}. Ask the owner for a role that has what you need.`,
          true,
        );
      }
      const docs = [...catalog]
        .filter(([name]) => !shown.has(name))
        .map(([name, entry]) => ({
          name,
          description: entry.config.description,
        }));
      const picked = rankTools(query, docs, Math.min(left, FIND_MAX));
      if (picked.length === 0) {
        return answer({
          added: [],
          left,
          note: "No tool matches. Name the action with the words a tool would use.",
        });
      }
      const held = await scope.grant(picked);
      const added = picked.filter((name) => held.includes(name));
      return answer({
        added: added.flatMap((name) => {
          const entry = catalog.get(name);
          return entry ? [schemaOf(name, entry)] : [];
        }),
        left: Math.max(EXTRA_TOOLS_MAX - held.length, 0),
        note: "Call them through tools_call; a new connection lists them too.",
      });
    },
  );

  // Registered as is: the tool it reaches journals the call under its own
  // name, so this hop is not counted twice.
  server.registerTool(
    "tools_call",
    {
      description:
        "Call a tool this session took with tools_find, by name, with its arguments.",
      inputSchema: callInput,
    },
    async (args) => {
      const parsed = callInput.safeParse(args);
      if (!parsed.success) return answer(z.prettifyError(parsed.error), true);
      const { name, arguments: input } = parsed.data;
      const entry = shown.has(name) ? catalog.get(name) : undefined;
      if (!entry) {
        return answer(
          `${name} is not among this session's tools. Find it with tools_find first.`,
          true,
        );
      }
      return entry.callback(input ?? {});
    },
  );
}
