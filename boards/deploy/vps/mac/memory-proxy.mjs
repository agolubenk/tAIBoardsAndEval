#!/usr/bin/env node
// Read-only window onto the Mac claude-mem worker for t-boards on d4dev (R-040, owner decision d-tb-claude-mem = proxy-ro).
// Listens on the WireGuard address only, accepts the d4dev peer only, and forwards exactly the GET routes
// packages/claude-mem-reader/src/client.ts calls. Nothing can be written or deleted through it.
//
//   node deploy/vps/mac/memory-proxy.mjs   (or: memory-agent.sh install)
//   CMEM_PROXY_LISTEN=10.77.0.2 CMEM_PROXY_PORT=37702 CMEM_PROXY_ALLOW=10.77.0.1,10.77.0.2  (defaults)
//
// The worker address comes from ~/.claude-mem/settings.json (CLAUDE_MEM_WORKER_HOST/PORT), as the reader does.
// While the tunnel is down the listen address does not exist: the proxy retries every 30 s instead of exiting.
import http from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LISTEN = process.env.CMEM_PROXY_LISTEN ?? "10.77.0.2";
const PORT = Number(process.env.CMEM_PROXY_PORT ?? 37702);
const ALLOW = new Set(
  (process.env.CMEM_PROXY_ALLOW ?? "10.77.0.1,10.77.0.2")
    .split(",")
    .map((s) => s.trim()),
);
const RETRY_MS = 30_000;
const UPSTREAM_TIMEOUT_MS = 10_000;

// The four reads of the t-boards memory reader — and nothing else.
const ROUTES = [
  /^\/api\/health$/,
  /^\/api\/projects$/,
  /^\/api\/observations$/,
  /^\/api\/observation\/[A-Za-z0-9_-]{1,64}$/,
];

function workerAddress() {
  let settings = {};
  try {
    settings = JSON.parse(
      readFileSync(join(homedir(), ".claude-mem", "settings.json"), "utf8"),
    );
  } catch {
    // no settings file — fall back to the worker defaults
  }
  return {
    host: settings.CLAUDE_MEM_WORKER_HOST || "127.0.0.1",
    port: Number(settings.CLAUDE_MEM_WORKER_PORT || 37777),
  };
}

const upstream = workerAddress();

function deny(res, status, reason) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(reason);
}

const server = http.createServer((req, res) => {
  const peer = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  if (!ALLOW.has(peer)) return deny(res, 403, "peer not allowed");
  if (req.method !== "GET") return deny(res, 405, "read-only");
  const url = new URL(req.url ?? "/", "http://proxy");
  if (!ROUTES.some((re) => re.test(url.pathname)))
    return deny(res, 403, "route not allowed");

  const out = http.request(
    {
      host: upstream.host,
      port: upstream.port,
      method: "GET",
      path: url.pathname + url.search,
      headers: { accept: "application/json" },
      timeout: UPSTREAM_TIMEOUT_MS,
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, {
        "content-type": up.headers["content-type"] ?? "application/json",
        "cache-control": "no-store",
      });
      up.pipe(res);
    },
  );
  out.on("timeout", () => out.destroy(new Error("upstream timeout")));
  out.on("error", () => {
    if (!res.headersSent) deny(res, 502, "worker unavailable");
    else res.destroy();
  });
  out.end();
});

server.on("error", (err) => {
  if (err.code === "EADDRNOTAVAIL" || err.code === "EADDRINUSE") {
    console.error(
      `[cmem-ro-proxy] ${LISTEN}:${PORT} unavailable (${err.code}), retry in ${RETRY_MS / 1000}s`,
    );
    setTimeout(() => server.listen(PORT, LISTEN), RETRY_MS);
    return;
  }
  throw err;
});

server.listen(PORT, LISTEN, () => {
  console.log(
    `[cmem-ro-proxy] ${LISTEN}:${PORT} -> ${upstream.host}:${upstream.port}, GET only, peers ${[...ALLOW].join(",")}`,
  );
});
