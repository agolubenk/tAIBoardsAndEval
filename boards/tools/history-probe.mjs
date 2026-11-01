// Live R-023 check on the local stand (API :1337 must be up): an agent edits a
// card under its lease, the history names the agent, the agent is refused a
// rollback, the owner rolls the edit back from a cookie session in one call.
// Prints outcomes only, never tokens. Synthetic data: a fresh project per run.
// Usage: node boards/tools/history-probe.mjs [apiBase]
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
const cookie = signIn.headers
  .getSetCookie()
  .map((c) => c.split(";")[0])
  .join("; ");

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
          "io.modelcontextprotocol/clientInfo": { name: "t-boards-probe-history", version: "0" },
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
  const { body } = parseAnswer(text);
  return { isError: Boolean(result.isError), text, body };
};
// Errors are printed whole: the cause is usually at the end.
const out = (r) => (r.isError ? { error: r.text } : "ok");


const ws = await call("list_workspaces", {});
const workspaceId = ws.body.data?.[0]?.id;
if (!workspaceId) throw new Error("no workspace: run tools/mcp-probe.mjs first");

const slug = Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
const project = await call("create_project", { workspaceId, name: `R-023 probe ${slug}`, slug, icon: "Layout" });
if (project.isError) throw new Error(`create_project: ${project.text}`);
const task = await call("create_task", {
  projectId: project.body.id, title: "R-023 tree", description: "before", priority: "low", status: "to-do",
});
if (task.isError) throw new Error(`create_task: ${task.text}`);
const taskId = task.body.id;

const lease = await call("forest_acquire_lease", { workspaceId, taskId, session: "dev-1" });
const guard = { session: "dev-1", fencingToken: lease.body.fencingToken };
const edit = await call("update_task", {
  taskId, title: "R-023 tree v2", description: "after", status: "in-progress", priority: "low", ...guard,
});

const cards = `${api}/forest/${workspaceId}/cards/${taskId}`;
const history = async () => (await fetch(`${cards}/history`, { headers: { ...origin, cookie } })).json();
const before = await history();
const entry = before.entries?.[0];
const rollback = (headers) => fetch(`${cards}/history/${entry.id}/rollback`, { method: "POST", headers });
const asAgent = await rollback({ ...origin, authorization: `Bearer ${token}` });
const asOwner = await rollback({ ...origin, cookie });
const after = await call("get_task", { taskId, fields: ["title", "description", "status"] });
await call("forest_release_lease", { workspaceId, taskId, ...guard });

console.log(JSON.stringify({
  edit: out(edit),
  history: before.entries?.map((e) => ({ kind: e.kind, actor: e.actorId?.split(":")[0] ?? null, fields: Object.keys(e.changes) })),
  agentRollback: { status: asAgent.status, body: await asAgent.text() },
  ownerRollback: { status: asOwner.status, body: asOwner.ok ? await asOwner.json() : await asOwner.text() },
  after: after.body,
  latest: (await history()).entries?.[0]?.actorId?.split(":")[0],
}, null, 1));
