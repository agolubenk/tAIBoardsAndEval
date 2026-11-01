// TOON vs JSON on the live MCP (R-033, D-018): each read tool is called in the
// default wire (the cheaper of the two), as "toon" and as "json", and the texts
// are counted with the pinned o200k counter from K-3. Synthetic data: a fresh project with
// eight tasks in the first workspace. Prints counts only, never tokens.
// Usage: node boards/tools/mcp-wire-measure.mjs [apiBase]
const { defaultCounter } = await import(
  new URL("../packages/agent-format/dist/index.js", import.meta.url).href
);
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
async function call(name, args) {
  const res = await fetch(`${api}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "mcp-method": "tools/call",
      "mcp-protocol-version": pv,
      "mcp-name": name,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++id,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": pv,
          "io.modelcontextprotocol/clientInfo": { name: "t-boards-wire", version: "0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const raw = await res.text();
  const json = raw.startsWith("{")
    ? JSON.parse(raw)
    : JSON.parse(raw.split("\n").find((l) => l.startsWith("data:")).slice(5));
  if (json.error) throw new Error(`${name}: ${JSON.stringify(json.error)}`);
  const text = json.result.content[0].text;
  if (json.result.isError) throw new Error(`${name}: ${text}`);
  return text;
}

const workspaceId = JSON.parse(await call("list_workspaces", { format: "json" })).data[0].id;
const slug = `W${Array.from({ length: 3 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("")}`;
const project = JSON.parse(await call("create_project", { workspaceId, name: `Wire ${slug}`, slug, icon: "Layout" }));
const taskIds = [];
for (let i = 1; i <= 8; i++) {
  const task = JSON.parse(await call("create_task", {
    projectId: project.id,
    title: `Wire task ${i}`,
    description: `Synthetic task ${i} for the TOON vs JSON count.`,
    priority: ["low", "medium", "high"][i % 3],
    status: "to-do",
  }));
  taskIds.push(task.id);
}

const reads = [
  ["list_workspaces", {}],
  ["list_projects", { workspaceId }],
  ["get_project", { id: project.id }],
  ["list_tasks", { projectId: project.id }],
  ["get_task", { taskId: taskIds[0] }],
  ["list_workspace_members", { workspaceId }],
  ["list_workspace_labels", { workspaceId }],
  ["forest_list_approvals", { workspaceId }],
  ["forest_get_card_meta", { workspaceId, taskId: taskIds[0] }],
];
const rows = [];
let wireTotal = 0;
let toonTotal = 0;
let jsonTotal = 0;
for (const [name, args] of reads) {
  try {
    const count = (format) => call(name, { ...args, budget: 2500, ...(format ? { format } : {}) }).then((t) => defaultCounter.count(t));
    const [wire, toon, json] = [await count(), await count("toon"), await count("json")];
    wireTotal += wire;
    toonTotal += toon;
    jsonTotal += json;
    rows.push({ name, wire, toon, json });
  } catch (error) {
    rows.push({ name, error: String(error.message ?? error) });
  }
}
console.log(JSON.stringify({ counter: defaultCounter.name, rows, wireTotal, toonTotal, jsonTotal }, null, 1));
