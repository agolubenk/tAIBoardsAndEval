// Uploads the repo's documents to the t-boards notebook: only files whose
// sha256 differs from the server's copy, then removes sources whose file is
// gone. The file list honours .gitignore, so ignored local folders stay home.
//   node notebook-sync.mjs [--dry-run]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, notebookApi, stamp } from "./notebook-client.mjs";

const KIND = "repo-doc";
const TEXT_MAX = 500_000;
// A listing that lost more than half the corpus is a broken checkout or a
// failed git call, not a cleanup: prune refuses it.
const PRUNE_FLOOR = 0.5;

export const PATHSPECS = [
  ":(glob)docs/**/*.md",
  ":(glob)**/CLAUDE.md",
  ":(glob).claude/rules/*.md",
  ":(glob)t-boards/*.md",
  ":(glob)supertick-eval/pipeline/*.md",
  ":(exclude,glob)docs/plans/archive/**",
  ":(exclude)docs/plans/BACKLOG.md",
];

export function listDocuments(repoRoot, git = "git") {
  const out = execFileSync(
    git,
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ...PATHSPECS,
    ],
    { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 },
  );
  return [...new Set(out.toString("utf8").split("\0").filter(Boolean))].sort();
}

export function titleOf(path, text) {
  const heading = text.match(/^#\s+(.+?)\s*#*\s*$/m);
  return (heading?.[1] || basename(path)).slice(0, 300);
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

async function main() {
  const config = loadConfig();
  const dryRun = process.argv.includes("--dry-run");
  if (!config.repoRoot) throw new Error("config.json needs repoRoot");
  const paths = listDocuments(config.repoRoot, config.git);
  const server = await notebookApi(config, "GET", "/sources");
  const known = new Map(
    server.sources
      .filter((source) => source.kind === KIND)
      .map((source) => [source.ref, source.contentSha256]),
  );

  const keep = [];
  let uploaded = 0;
  let unchanged = 0;
  let skipped = 0;
  for (const path of paths) {
    let text;
    try {
      text = readFileSync(join(config.repoRoot, path), "utf8");
    } catch {
      skipped++;
      continue;
    }
    if (text.length > TEXT_MAX) {
      console.warn(
        `${stamp()} skip ${path}: ${text.length} chars > ${TEXT_MAX}`,
      );
      skipped++;
      continue;
    }
    keep.push(path);
    if (known.get(path) === sha256(text)) {
      unchanged++;
      continue;
    }
    if (!dryRun) {
      await notebookApi(config, "PUT", "/sources", {
        kind: KIND,
        ref: path,
        title: titleOf(path, text),
        text,
      });
    }
    uploaded++;
  }

  let pruned = 0;
  if (known.size && keep.length < known.size * PRUNE_FLOOR) {
    console.error(
      `${stamp()} prune refused: ${keep.length} local files against ${known.size} on the server`,
    );
  } else if (!dryRun) {
    ({ deleted: pruned } = await notebookApi(config, "POST", "/sources/prune", {
      kind: KIND,
      keep,
    }));
  }
  console.log(
    `${stamp()} sync${dryRun ? " (dry run)" : ""}: ${paths.length} files, uploaded ${uploaded}, unchanged ${unchanged}, skipped ${skipped}, pruned ${pruned}`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`${stamp()} ${error.message}`);
    process.exit(1);
  });
}
