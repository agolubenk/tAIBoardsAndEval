// Live probe of the t-boards MCP on the local stand (API :1337 must be up).
// Prints shapes only, never tokens. Each run creates synthetic data:
// project "Probe forest" (random slug P***) and task "Probe tree" in the first workspace.
// Usage: node boards/tools/mcp-probe.mjs [apiBase]
// Read tools answer TOON by default (R-033); the probe decodes it with K-3.
const { decodeResponse, defaultCounter } = await import(
  new URL("../packages/agent-format/dist/index.js", import.meta.url).href
);
const parseAnswer = (text) => {
  try { return { body: JSON.parse(text), format: "json" }; } catch {}
  try { return { body: decodeResponse(text, "toon"), format: "toon" }; } catch {}
  return { body: { raw: text }, format: "text" };
};
const api = process.argv[2] ?? "http://localhost:1337/api";
const pv = "2026-07-28";
const origin = { Origin: "http://localhost:5173", "Content-Type": "application/json" };

const signIn = await fetch(`${api}/auth/sign-in/email`, {
  method: "POST",
  headers: origin,
  body: JSON.stringify({ email: "admin@t-boards.local", password: "admin" }),
});
const { token } = await signIn.json();
if (!token) throw new Error(`sign-in ${signIn.status}: no token`);

let id = 0;
async function rpc(method, params = {}) {
  const res = await fetch(`${api}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-protocol-version": pv,
      ...(method === "tools/call" ? { "mcp-name": params.name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++id,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": pv,
          "io.modelcontextprotocol/clientInfo": { name: "t-boards-probe", version: "0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const text = await res.text();
  const json = text.startsWith("{")
    ? JSON.parse(text)
    : JSON.parse(text.split("\n").find((l) => l.startsWith("data:")).slice(5));
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}
const call = async (name, args) => {
  const result = await rpc("tools/call", { name, arguments: args });
  const text = result.content[0].text;
  const { body, format } = parseAnswer(text);
  // o200k tokens of the wire text and of the same answer as compact JSON.
  return {
    isError: result.isError, text, body, format,
    tokens: defaultCounter.count(text),
    jsonTokens: defaultCounter.count(JSON.stringify(body)),
  };
};

const { tools } = await rpc("tools/list");
const forest = tools.filter((t) => t.name.startsWith("forest_")).map((t) => t.name);
const listTasks = tools.find((t) => t.name === "list_tasks");

const ws = await call("list_workspaces", {});
let workspaceId = ws.body.data?.[0]?.id;
if (!workspaceId) {
  const created = await fetch(`${api}/auth/organization/create`, {
    method: "POST",
    headers: { ...origin, authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: "Probe", slug: "probe" }),
  });
  workspaceId = (await created.json()).id;
  console.log("created workspace", created.status);
}
const slug = `P${Array.from({ length: 3 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("")}`;
const project = await call("create_project", { workspaceId, name: "Probe forest", slug, icon: "Layout" });
const projectId = project.body.id;
const task = await call("create_task", { projectId, title: "Probe tree", description: "x", priority: "low", status: "to-do" });
const taskId = task.body.id;
const lease1 = await call("forest_acquire_lease", { workspaceId, taskId, session: "dev-1" });
const lease2 = await call("forest_acquire_lease", { workspaceId, taskId, session: "dev-2" });
const released = await call("forest_release_lease", { workspaceId, taskId, session: "dev-1", fencingToken: lease1.body.fencingToken });
const getTask = await call("get_task", { taskId, fields: ["title", "status"] });
const getTaskAgain = await call("get_task", { taskId, ifNoneMatch: getTask.body.etag });
const logs = await call("forest_list_logs", { workspaceId, take: 5 });
const again = await call("forest_list_logs", { workspaceId, take: 5, ifNoneMatch: logs.body.etag });
const projects = await call("list_projects", { workspaceId });
const projectsSmall = await call("list_projects", { workspaceId, budget: 150, fields: ["name"] });
const noSession = await call("forest_acquire_lease", { workspaceId, taskId: "none" });

// Errors are printed whole: the cause is usually at the end.
const err = (r) => (r.isError ? r.text : "ok");
console.log(JSON.stringify({
  tools: tools.length,
  forest,
  listTasksHasBudget: Boolean(listTasks?.inputSchema?.properties?.budget),
  project: err(project),
  task: err(task),
  lease1: lease1.isError ? lease1.text : { token: lease1.body.fencingToken },
  lease2: { isError: lease2.isError, text: lease2.text },
  released: released.body,
  getTask: getTask.body,
  getTaskAgain: getTaskAgain.body,
  logs: { keys: Object.keys(logs.body), format: logs.format, tokens: logs.tokens, jsonTokens: logs.jsonTokens },
  unchanged: again.body,
  getTaskTokens: { format: getTask.format, tokens: getTask.tokens, jsonTokens: getTask.jsonTokens },
  projects: { format: projects.format, tokens: projects.tokens, jsonTokens: projects.jsonTokens },
  projectsSmall: { tokens: projectsSmall.tokens, truncated: projectsSmall.body.truncated ?? false },
  noSession: { isError: noSession.isError, text: noSession.text },
}, null, 1));
