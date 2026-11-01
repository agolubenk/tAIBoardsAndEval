#!/usr/bin/env node
// Uploads the SSR corpus (skills, rules, agents, genomes, prompts, nerve,
// ai-council config, product prompts) to tAI-Boards: files whose sha256 is
// new to the server ride along, everything else travels as a manifest entry.
// The corpus allowlist lives on the server too — a path outside it aborts
// the whole sync. Reads git-tracked files at HEAD only (spec RU-4), never
// the working tree, so local scratch files cannot leak into snapshots.
//   node ssr-sync.mjs [--dry-run]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { loadConfig } from "./notebook-client.mjs";

const PATHSPECS = [
  ":(glob).claude/skills/**",
  ":(glob).claude/rules/*.md",
  ":(glob).claude/agents/*.md",
  ":(glob)supertick-eval/pipeline/genome/**",
  ":(glob)supertick-eval/prompts/**",
  ":(glob)supertick-eval/nerve/**",
  // the product home (tAIBE) keeps the eval tree at eval/ (apps/api/src/ssr/corpus.ts reads both)
  ":(glob)eval/pipeline/genome/**",
  ":(glob)eval/prompts/**",
  ":(glob)eval/nerve/**",
  ":(glob)infra/ai-council/config.toml",
  ":(glob)apps/backend/src/modules/ai/prompts/**",
  ":(glob)apps/backend/src/modules/ai/prompt-templates/**",
  ":(exclude,glob)**/node_modules/**",
];

const FILE_MAX = 600_000;

function listCorpus(repoRoot, git = "git") {
  const out = execFileSync(
    git,
    ["ls-files", "--cached", "-z", "--", ...PATHSPECS],
    { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 },
  );
  return out.toString("utf8").split("\0").filter(Boolean).sort();
}

function headCommit(repoRoot, git = "git") {
  return execFileSync(git, ["rev-parse", "HEAD"], { cwd: repoRoot })
    .toString("utf8")
    .trim();
}

function fileAtHead(repoRoot, path, git = "git") {
  return execFileSync(git, ["show", `HEAD:${path}`], {
    cwd: repoRoot,
    maxBuffer: 8 * 1024 * 1024,
  });
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const stamp = (message) =>
  console.log(`${new Date().toISOString()} ${message}`);

async function ssrApi(config, path, method, body, timeoutMs = 60_000) {
  const url = `${config.baseUrl}/api/ssr/${encodeURIComponent(config.workspaceId)}${path}`;
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
      `${method} ${path}: HTTP ${response.status} ${text.slice(0, 300)}`,
    );
  }
  return text ? JSON.parse(text) : null;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const config = await loadConfig();
  const repoRoot = config.repoRoot ?? process.cwd();
  const commitSha = headCommit(repoRoot, config.git);
  const paths = listCorpus(repoRoot, config.git);

  const files = [];
  for (const path of paths) {
    const content = fileAtHead(repoRoot, path, config.git);
    if (content.byteLength > FILE_MAX) {
      stamp(`skip ${path}: larger than ${FILE_MAX} bytes`);
      continue;
    }
    files.push({
      path,
      sha256: sha256(content),
      content: content.toString("utf8"),
    });
  }

  // Ask which shas the server already stores so only new content uploads.
  const known = new Set(
    (
      await ssrApi(config, "/known-shas", "POST", {
        shas: files.map((file) => file.sha256),
      })
    ).shas ?? [],
  );
  const payload = {
    commitSha,
    files: files.map((file) =>
      known.has(file.sha256)
        ? { path: file.path, sha256: file.sha256 }
        : { path: file.path, sha256: file.sha256, content: file.content },
    ),
  };

  stamp(
    `${dryRun ? "[dry-run] " : ""}${files.length} corpus files at ${commitSha.slice(0, 10)}, ${payload.files.filter((file) => file.content).length} to upload`,
  );
  if (dryRun) return;

  const result = await ssrApi(config, "/sync", "POST", payload);
  stamp(
    `synced: ${result.created.length} new (drafts), ${result.bumped.length} bumped, ${result.unchanged} unchanged, ${result.archived.length} archived`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
