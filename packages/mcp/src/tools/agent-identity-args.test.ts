import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  type AgentIdentity,
  currentAgentIdentity,
} from "../kaneo/agent-identity.js";
import { createRegisterTool, run } from "./register-tool.js";

type Handler = (args: unknown) => Promise<CallToolResult>;

function setup() {
  const handlers = new Map<string, Handler>();
  const schemas = new Map<string, z.ZodObject>();
  const server = {
    registerTool: (
      name: string,
      config: { inputSchema: z.ZodObject },
      handler: Handler,
    ) => {
      handlers.set(name, handler);
      schemas.set(name, config.inputSchema);
    },
  };
  const seen: { args: unknown; identity: AgentIdentity | undefined }[] = [];
  const registerTool = createRegisterTool(
    server as never,
    { json: async () => null },
    { agentIdentity: { defaultHarness: () => "claude-code" } },
  );
  registerTool(
    "list_workspaces",
    { description: "", inputSchema: z.object({}) },
    async (args) =>
      run(async () => {
        seen.push({ args, identity: currentAgentIdentity() });
        return [];
      }),
  );
  registerTool(
    "forest_set_work_state",
    {
      description: "",
      inputSchema: z.object({ session: z.string(), step: z.string() }),
    },
    async (args) =>
      run(async () => {
        seen.push({ args, identity: currentAgentIdentity() });
        return null;
      }),
  );
  const call = (name: string, args: unknown) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`no ${name}`);
    return handler(args);
  };
  return { call, seen, schemas };
}

describe("agent identity arguments (R-010)", () => {
  it("offers session and harness on every tool", () => {
    const { schemas } = setup();
    expect(Object.keys(schemas.get("list_workspaces")?.shape ?? {})).toEqual(
      expect.arrayContaining(["session", "harness"]),
    );
  });

  it("runs the call as the session and keeps the arguments clean", async () => {
    const { call, seen } = setup();
    await call("list_workspaces", {
      session: "successor bb",
      harness: "Codex",
    });
    expect(seen[0]).toEqual({
      args: {},
      identity: { harness: "codex", session: "successor bb" },
    });
  });

  it("falls back to the harness's default agent", async () => {
    const { call, seen } = setup();
    await call("list_workspaces", {});
    expect(seen[0]?.identity).toEqual({
      harness: "claude-code",
      session: undefined,
    });
  });

  it("leaves a tool's own session in its arguments", async () => {
    const { call, seen } = setup();
    await call("forest_set_work_state", { session: "d9", step: "Ревью" });
    expect(seen[0]).toEqual({
      args: { session: "d9", step: "Ревью" },
      identity: { harness: "claude-code", session: "d9" },
    });
  });
});
