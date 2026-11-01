// Live R-031 check on the local stand (API :1337 must be up): the context pack
// of a typical card through MCP, its size in tokens per view mode (AC-012:
// 150–2500, «не изменилось» without a body), and search excerpts against the
// raw REST answer. Prints sizes and outcomes only, never tokens or bodies.
// Synthetic data: a fresh project per run.
// Usage: node boards/tools/mcp-probe-r031.mjs [apiBase]
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
const out = (r) => (r.isError ? { error: r.text } : "ok");
const tokens = (text) => defaultCounter.count(text);

const ws = await call("list_workspaces", {});
const workspaceId = ws.body.data?.[0]?.id;
if (!workspaceId) throw new Error("no workspace: run tools/mcp-probe.mjs first");
const slug = Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
const project = await call("create_project", { workspaceId, name: `R031 probe ${slug}`, slug, icon: "Layout" });
if (project.isError) throw new Error(`create_project: ${project.text}`);
const projectId = project.body.id;

// A typical card: a page-long description, a blocker, a few comments, a lease
// and an open «да» request.
const paragraph = "Импорт карточек из Notion должен сохранять поля Backlog ID, Severity и Half-baked idea; зеркало сверяется раз в час, конфликт решает владелец. ";
const description = `${paragraph.repeat(6)}Маркер-${slug} стоит в середине. ${paragraph.repeat(6)}`;
const task = await call("create_task", { projectId, title: "R031 typical card", description, priority: "high", status: "to-do" });
if (task.isError) throw new Error(`create_task: ${task.text}`);
const taskId = task.body.id;
const blocker = await call("create_task", { projectId, title: "R031 blocker", description: "x", priority: "low", status: "to-do" });
const related = await call("create_task_relation", { sourceTaskId: blocker.body.id, targetTaskId: taskId, relationType: "blocks" });
for (let i = 1; i <= 5; i++) {
  await call("create_task_comment", { taskId, content: `Комментарий ${i}: проверил шаг ${i}, дальше по плану. ${paragraph}` });
}
const lease = await call("forest_acquire_lease", { workspaceId, taskId, session: "dev-1" });
const guard = { session: "dev-1", fencingToken: lease.body.fencingToken };
await call("forest_set_card_meta", { workspaceId, taskId, branch: "probe/r031", files: ["a.ts:1", "b.ts:2"], ...guard });
const asked = await call("forest_request_approval", { workspaceId, action: "close_task", targetId: taskId, value: "done", reason: "R031 live check" });

// Everything above is older than this mark; a comment after it is the change.
await new Promise((resolve) => setTimeout(resolve, 50));
const mark = new Date().toISOString();
await new Promise((resolve) => setTimeout(resolve, 50));
await call("create_task_comment", { taskId, content: "Новый комментарий после метки." });
const pack = (args) => call("forest_get_context", { workspaceId, taskId, ...args });
const full = await pack({ budget: 2500 });
const json = await pack({ budget: 2500, format: "json" });
const summary = await pack({ summary: true });
const narrow = await pack({ fields: ["title", "status", "meta", "lease", "truncated"] });
const capped = await pack({ budget: 600 });
const etag = full.body.etag;
const unchanged = await pack({ ifNoneMatch: etag });
const since = await pack({ since: mark });

const size = (r) => (r.isError ? { error: r.text } : { tokens: tokens(r.text) });
const sections = full.body.data ?? {};
const restSearch = await fetch(`${api}/search?${new URLSearchParams({ q: `Маркер-${slug}`, workspaceId })}`, {
  headers: { authorization: `Bearer ${token}` },
});
const restText = await restSearch.text();
const search = await call("search", { q: `Маркер-${slug}`, workspaceId, budget: 2500 });
const hit = search.body.data?.results?.[0];

console.log(JSON.stringify({
  counter: defaultCounter.name,
  setup: { relation: out(related), approval: out(asked), lease: out(lease) },
  pack: {
    sections: {
      labels: sections.labels?.length, relations: sections.relations?.length,
      comments: sections.comments?.length, history: sections.history?.length,
      approvals: sections.approvals?.length, lease: Boolean(sections.lease),
      branch: sections.meta?.branch, truncated: sections.truncated,
      leaksFence: JSON.stringify(sections).includes("fencingToken"),
    },
    default: size(full), json: size(json), summary: size(summary),
    fields: size(narrow), budget600: size(capped),
    unchanged: { ...size(unchanged), unchanged: unchanged.body.unchanged === true },
    sinceMark: { ...size(since), comments: since.body.data?.comments?.length, hasDescription: "description" in (since.body.data ?? {}) },
  },
  search: {
    restTokens: tokens(restText),
    mcpTokens: tokens(search.text),
    excerptChars: hit?.description?.length,
    fullChars: description.length,
    excerptHasMatch: Boolean(hit?.description?.includes(`Маркер-${slug}`)),
  },
}, null, 1));
