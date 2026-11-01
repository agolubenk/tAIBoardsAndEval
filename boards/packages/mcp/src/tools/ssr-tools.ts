import { z } from "zod";
import type { ToolClient } from "./register.js";
import { type RegisterTool, run } from "./register-tool.js";

const versionField = z
  .string()
  .trim()
  .regex(/^(latest|-1|\d+)$/)
  .optional()
  .describe(
    "Which version to serve: 'latest' (default), '-1' for the previous one, or an explicit version number. The answer names the resolved version so a relative request stays reproducible.",
  );

const idField = z.string().trim().min(1);

function artifactTool(
  registerTool: RegisterTool,
  client: ToolClient,
  name: string,
  kind: string,
  description: string,
) {
  registerTool(
    name,
    {
      description,
      inputSchema: z.object({
        workspaceId: idField,
        name: idField.describe(
          `Entity name: a skill folder name or the file name of the ${kind}.`,
        ),
        version: versionField,
      }),
    },
    ({ workspaceId, name, version }) =>
      run(() =>
        client.json(
          `/api/ssr/${encodeURIComponent(workspaceId)}/entities/by-name/${encodeURIComponent(name)}/content?kind=${encodeURIComponent(kind)}${version ? `&version=${encodeURIComponent(version)}` : ""}`,
          { method: "GET" },
        ),
      ),
  );
}

// SSR serving tools (spec RU-5/RU-8, D-006): read-only versioned access for
// sessions. Writing versions is the Mac sync agent's job; the owner decides.
export function registerSsrTools(
  registerTool: RegisterTool,
  client: ToolClient,
) {
  artifactTool(
    registerTool,
    client,
    "get_skill",
    "skill",
    "Serve a skill from the SSR registry: the whole folder (SKILL.md and its files) at a chosen version. Latest by default; ask for '-1' to compare with what ran before.",
  );
  artifactTool(
    registerTool,
    client,
    "get_rule",
    "rule",
    "Serve a rule file from the SSR registry at a chosen version (latest by default, '-1' or an explicit number).",
  );
  artifactTool(
    registerTool,
    client,
    "get_prompt",
    "prompt",
    "Serve a prompt file from the SSR registry at a chosen version (latest by default, '-1' or an explicit number). Covers launch prompts, lenses and role prompts.",
  );
  registerTool(
    "ssr_list",
    {
      description:
        "List SSR registry entities (skills, rules, agents, genomes, prompts, nerve configs, ai-council config, product prompts) with their latest version and status. Use it to discover names before get_skill/get_rule/get_prompt.",
      inputSchema: z.object({ workspaceId: idField }),
    },
    ({ workspaceId }) =>
      run(() =>
        client.json(`/api/ssr/${encodeURIComponent(workspaceId)}/entities`, {
          method: "GET",
        }),
      ),
  );
}
