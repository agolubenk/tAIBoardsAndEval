// Shared by the Mac notebook worker and sync: config from
// ~/.t-boards-notebook (or $T_BOARDS_NOTEBOOK_HOME) and calls to the
// notebook API with the workspace API key. The key is never printed.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function loadConfig() {
  const home =
    process.env.T_BOARDS_NOTEBOOK_HOME || join(homedir(), ".t-boards-notebook");
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  const apiKey = readFileSync(join(home, "api_key"), "utf8").trim();
  if (!config.workspaceId || !apiKey) {
    throw new Error(`${home}: config.json needs workspaceId, api_key a key`);
  }
  return {
    home,
    baseUrl: (config.baseUrl || "https://d4dev.admin.hrhelper.space").replace(
      /\/+$/,
      "",
    ),
    workspaceId: config.workspaceId,
    ollamaUrl: (config.ollamaUrl || "http://127.0.0.1:11434").replace(
      /\/+$/,
      "",
    ),
    repoRoot: config.repoRoot,
    git: config.git || "git",
    apiKey,
  };
}

export async function notebookApi(
  config,
  method,
  path,
  body,
  timeoutMs = 30_000,
) {
  const url = `${config.baseUrl}/api/notebook/${encodeURIComponent(config.workspaceId)}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      "x-api-key": config.apiKey,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `${method} ${path}: HTTP ${response.status} ${text.slice(0, 200)}`,
    );
  }
  return text ? JSON.parse(text) : null;
}

export const stamp = () => new Date().toISOString();
