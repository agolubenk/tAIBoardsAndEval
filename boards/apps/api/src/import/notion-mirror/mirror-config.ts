import { readFileSync } from "node:fs";

// Every two hours, off the hour: the transition window shrank to days, so a
// clean streak (AC-003) has to be measured in runs, not only in calendar days.
export const DEFAULT_MIRROR_CRON = "7 */2 * * *";
// A streak breaks when no run finished for this long (VPS down, Notion out).
export const DEFAULT_MAX_GAP_HOURS = 5;

export const DISCOVER_ALL = "all";

export type NotionMirrorConfig = {
  workspaceId: string;
  databaseIds: string[];
  // "all" in NOTION_MIRROR_DATABASES: also every other database the
  // integration can read, after the listed ones.
  discover: boolean;
  tokenFile: string;
  product?: string;
  cron: string;
  maxGapHours: number;
};

// The scheduled mirror is off unless the workspace, the databases and the
// token file are all set. The token comes from a file only (N-007), read on
// every run so a rotated token needs no restart.
export function readMirrorConfig(
  env: NodeJS.ProcessEnv = process.env,
): NotionMirrorConfig | null {
  const workspaceId = env.NOTION_MIRROR_WORKSPACE_ID?.trim();
  const tokenFile = env.NOTION_MIRROR_TOKEN_FILE?.trim();
  const entries = (env.NOTION_MIRROR_DATABASES ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const discover = entries.some((id) => id.toLowerCase() === DISCOVER_ALL);
  const databaseIds = [
    ...new Set(entries.filter((id) => id.toLowerCase() !== DISCOVER_ALL)),
  ];
  if (!workspaceId || !tokenFile || (!discover && databaseIds.length === 0)) {
    return null;
  }

  const gap = Number(env.NOTION_MIRROR_MAX_GAP_HOURS);
  return {
    workspaceId,
    databaseIds,
    discover,
    tokenFile,
    product: env.NOTION_MIRROR_PRODUCT?.trim() || undefined,
    cron: env.NOTION_MIRROR_CRON?.trim() || DEFAULT_MIRROR_CRON,
    maxGapHours: Number.isFinite(gap) && gap > 0 ? gap : DEFAULT_MAX_GAP_HOURS,
  };
}

// The listed databases first, in their order, then the discovered ones by
// title, so projects keep a stable order on the board run after run.
export function mirrorDatabaseOrder(
  listed: string[],
  discovered: { id: string; title: string }[],
): string[] {
  const norm = (id: string) => id.replaceAll("-", "").toLowerCase();
  const seen = new Set(listed.map(norm));
  const rest = discovered
    .filter((d) => !seen.has(norm(d.id)))
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
    .map((d) => d.id);
  return [...listed, ...rest];
}

export function maxGapHours(env: NodeJS.ProcessEnv = process.env): number {
  return readMirrorConfig(env)?.maxGapHours ?? DEFAULT_MAX_GAP_HOURS;
}

export function readMirrorToken(config: NotionMirrorConfig): string {
  let token: string;
  try {
    token = readFileSync(config.tokenFile, "utf8").trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    throw new Error(`NOTION_MIRROR_TOKEN_FILE could not be read (${code})`);
  }
  if (!token) throw new Error("NOTION_MIRROR_TOKEN_FILE is empty");
  return token;
}
