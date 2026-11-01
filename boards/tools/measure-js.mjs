// JS weight of a web build (AC-018): the critical path is what index.html
// loads before anything renders — module scripts, modulepreload links and
// stylesheets — plus the static imports of those chunks; everything else is
// lazy. Sizes are gzip -9, as the spec's budget table counts them.
// Usage: node boards/tools/measure-js.mjs [apps/web/dist] [--json]
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const dist = resolve(args.find((a) => !a.startsWith("--")) ?? "apps/web/dist");

const gz = (path) =>
  gzipSync(readFileSync(join(dist, path)), { level: 9 }).length;
const kb = (bytes) => Math.round(bytes / 102.4) / 10;

const html = readFileSync(join(dist, "index.html"), "utf8");
const entry = [
  ...html.matchAll(/<script[^>]+type="module"[^>]+src="\/?([^"]+)"/g),
  ...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="\/?([^"]+)"/g),
].map((m) => m[1]);
const css = [
  ...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="\/?([^"]+)"/g),
].map((m) => m[1]);

// Static imports only: `import ... from "./x.js"` / `import "./x.js"`;
// `import("./x.js")` is lazy and stays off the critical path.
const STATIC_IMPORT =
  /(?:^|[;\n}])\s*import\s*(?:[\w*{}\s,$]+from\s*)?["'](\.\.?\/[^"']+\.js)["']/g;
const critical = new Set();
const queue = [...entry];
while (queue.length > 0) {
  const file = queue.shift();
  if (critical.has(file)) continue;
  critical.add(file);
  const code = readFileSync(join(dist, file), "utf8");
  for (const m of code.matchAll(STATIC_IMPORT)) {
    queue.push(posix.normalize(posix.join(posix.dirname(file), m[1])));
  }
}

const allJs = [];
const walk = (dir) => {
  for (const name of readdirSync(join(dist, dir))) {
    const rel = posix.join(dir, name);
    if (statSync(join(dist, rel)).isDirectory()) walk(rel);
    else if (name.endsWith(".js")) allJs.push(rel);
  }
};
walk("assets");

const sum = (files) => files.reduce((total, f) => total + gz(f), 0);
const criticalFiles = [...critical];
const result = {
  dist,
  criticalJsGzipKb: kb(sum(criticalFiles)),
  criticalCssGzipKb: kb(sum(css)),
  criticalFiles: criticalFiles.length,
  totalJsGzipKb: kb(sum(allJs)),
  totalJsFiles: allJs.length,
  largestCritical: criticalFiles
    .map((f) => ({ file: f, gzipKb: kb(gz(f)) }))
    .sort((a, b) => b.gzipKb - a.gzipKb)
    .slice(0, 5),
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(
    `critical path: JS ${result.criticalJsGzipKb} KB gzip in ${result.criticalFiles} files, CSS ${result.criticalCssGzipKb} KB`,
  );
  console.log(
    `all JS: ${result.totalJsGzipKb} KB gzip in ${result.totalJsFiles} files`,
  );
  for (const item of result.largestCritical) {
    console.log(`  ${item.gzipKb} KB  ${item.file}`);
  }
}
