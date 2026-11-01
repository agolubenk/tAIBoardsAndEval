// Live S4 check on the local stand (API :1337 must be up): an agent moves a card
// through MCP under its lease, is refused a close without the owner's «да», asks
// for it, the owner approves from a cookie session, the close goes through once.
// Prints outcomes only, never tokens. Synthetic data: a fresh project per run.
// Usage: node boards/tools/mcp-probe-s4.mjs [apiBase]
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
          "io.modelcontextprotocol/clientInfo": { name: "t-boards-probe-s4", version: "0" },
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
const project = await call("create_project", { workspaceId, name: `S4 probe ${slug}`, slug, icon: "Layout" });
if (project.isError) throw new Error(`create_project: ${project.text}`);
const task = await call("create_task", {
  projectId: project.body.id, title: "S4 tree", description: "x", priority: "low", status: "to-do",
});
if (task.isError) throw new Error(`create_task: ${task.text}`);
const taskId = task.body.id;

const lease = await call("forest_acquire_lease", { workspaceId, taskId, session: "dev-1" });
const fencingToken = lease.body.fencingToken;
const guard = { session: "dev-1", fencingToken };

const noFence = await call("update_task_status", { taskId, status: "in-progress", session: "dev-1" });
const moved = await call("update_task_status", { taskId, status: "in-progress", ...guard });
const unapproved = await call("update_task_status", { taskId, status: "done", ...guard });
const asked = await call("forest_request_approval", {
  workspaceId, action: "close_task", targetId: taskId, value: "done", reason: "S4 live check",
});
const approvalId = asked.body.id;

// MCP has no decide tool; the agent's bearer on the REST route must be refused.
const decideAs = (headers) =>
  fetch(`${api}/forest/${workspaceId}/approvals/${approvalId}/decide`, {
    method: "POST",
    headers: { ...origin, ...headers },
    body: JSON.stringify({ decision: "approved" }),
  });
const selfDecide = await decideAs({ authorization: `Bearer ${token}` });
const selfBody = await selfDecide.json().catch(() => ({}));
const decide = await decideAs({ cookie });
const decideBody = await decide.json().catch(() => ({}));

const closed = await call("update_task_status", { taskId, status: "done", approvalId, ...guard });
const reopened = await call("update_task_status", { taskId, status: "in-progress", ...guard });
const reused = await call("update_task_status", { taskId, status: "done", approvalId, ...guard });
const final = await call("get_task", { taskId, fields: ["status"] });

// Card fields (R-024): the agent writes its own under the lease; a card the
// owner marked half-baked is not taken.
const cardSet = await call("forest_set_card_meta", { workspaceId, taskId, branch: "probe/s4", files: ["a.ts:1"], ...guard });
const cardGet = await call("forest_get_card_meta", { workspaceId, taskId, fields: ["branch", "files", "halfBaked"] });
const idea = await call("create_task", { projectId: project.body.id, title: "S4 raw idea", description: "x", priority: "low", status: "to-do" });
const mark = await fetch(`${api}/forest/${workspaceId}/cards/${idea.body.id}/meta`, {
  method: "PUT", headers: { ...origin, cookie }, body: JSON.stringify({ halfBaked: true }),
});
const ideaLease = await call("forest_acquire_lease", { workspaceId, taskId: idea.body.id, session: "dev-1" });

console.log(JSON.stringify({
  lease: lease.isError ? { error: lease.text } : "ok",
  noFence: out(noFence),
  moved: out(moved),
  unapproved: out(unapproved),
  asked: asked.isError ? { error: asked.text } : { status: asked.body.status, params: asked.body.params },
  selfDecide: { status: selfDecide.status, message: selfBody.message },
  ownerDecide: { status: decide.status, approval: decideBody.status ?? decideBody.message },
  closed: out(closed),
  reopened: out(reopened),
  reused: out(reused),
  final: final.body,
  cardSet: out(cardSet),
  cardGet: cardGet.isError ? { error: cardGet.text } : cardGet.body,
  ownerMarksHalfBaked: mark.status,
  halfBakedLease: out(ideaLease),
}, null, 1));
