import type { ToolClient } from "../register.js";
import type { RegisterTool } from "../register-tool.js";
import { registerForestCardTools } from "./card-tools.js";
import { registerForestReadTools } from "./read-tools.js";
import { registerForestWriteTools } from "./write-tools.js";

export function registerForestTools(
  registerTool: RegisterTool,
  client: ToolClient,
) {
  registerForestReadTools(registerTool, client);
  registerForestWriteTools(registerTool, client);
  registerForestCardTools(registerTool, client);
}
