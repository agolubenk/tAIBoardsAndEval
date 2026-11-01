// Live R-034 check on the local stand (API :1337 must be up): tools/list of
// every role against the full set, counted with the pinned o200k counter from
// K-3; a reader session takes tools with tools_find until it is refused, calls
// one through tools_call, and an unknown role is refused. Each run signs in
// anew, so its grants start empty. Prints counts and outcomes, never tokens.
// Usage: node boards/tools/tool-scope-probe.mjs [apiBase]
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
async function rpc(role, method, params = {}) {
  const res = await fetch(`${api}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-protocol-version": pv,
      ...(method === "tools/call" ? { "mcp-name": params.name } : {}),
      ...(role ? { "x-t-boards-role": role } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++id,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": pv,
          "io.modelcontextprotocol/clientInfo": { name: "t-boards-scope", version: "0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const raw = await res.text();
  if (!res.ok) return { status: res.status, body: JSON.parse(raw) };
  const json = raw.startsWith("{")
    ? JSON.parse(raw)
    : JSON.parse(raw.split("\n").find((l) => l.startsWith("data:")).slice(5));
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return { status: res.status, result: json.result };
}

async function list(role) {
  const { result } = await rpc(role, "tools/list");
  return {
    names: result.tools.map((tool) => tool.name),
    tokens: defaultCounter.count(JSON.stringify(result.tools)),
  };
}

const full = await list(undefined);
const roles = {};
for (const role of ["reader", "developer", "reviewer", "planner", "forester"]) {
  const scoped = await list(role);
  roles[role] = {
    tools: scoped.names.length,
    tokens: scoped.tokens,
    savedPct: Math.round((1 - scoped.tokens / full.tokens) * 100),
  };
}

const unknown = await rpc("admin", "tools/list");

const finds = [];
for (const query of ["log a time entry", "notifications", "workspace members", "delete a label", "create a project"]) {
  const { result } = await rpc("reader", "tools/call", { name: "tools_find", arguments: { query } });
  const text = result.content[0].text;
  if (result.isError) {
    finds.push({ query, refused: true, tokens: defaultCounter.count(text) });
    break;
  }
  const body = JSON.parse(text);
  finds.push({
    query,
    added: body.added.map((tool) => tool.name),
    left: body.left,
    tokens: defaultCounter.count(text),
  });
}

const after = await list("reader");
const taken = finds.flatMap((find) => find.added ?? []);
const reach = taken.includes("list_notifications")
  ? await rpc("reader", "tools/call", {
      name: "tools_call",
      arguments: { name: "list_notifications", arguments: {} },
    })
  : undefined;
const refused = await rpc("reader", "tools/call", {
  name: "tools_call",
  arguments: { name: "delete_task", arguments: { taskId: "none" } },
});

console.log(
  JSON.stringify(
    {
      counter: defaultCounter.name,
      full: { tools: full.names.length, tokens: full.tokens },
      roles,
      unknownRole: { status: unknown.status, error: unknown.body?.error },
      finds,
      readerAfter: { tools: after.names.length, tokens: after.tokens, taken },
      callTaken: reach ? { isError: Boolean(reach.result.isError) } : "list_notifications not taken",
      callNotTaken: { isError: Boolean(refused.result.isError) },
    },
    null,
    1,
  ),
);
