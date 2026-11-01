import db from "../database";
import { workspaceTable } from "../database/schema";
import { pushBackConfigured, runNightlyPush } from "../ssr/pushback";

// Nightly push-back (spec RU-9): reconcile every workspace's served-latest
// files into the product repo. Disabled without a token — a missing config
// is a setup state, not an error worth paging anyone for.
export async function runNightlySsrPush(): Promise<{ degraded?: boolean }> {
  if (!pushBackConfigured()) {
    console.log(
      "SSR push-back skipped: SSR_PUSH_GITHUB_TOKEN is not configured",
    );
    return {};
  }
  let degraded = false;
  const workspaces = await db
    .select({ id: workspaceTable.id })
    .from(workspaceTable);
  for (const workspace of workspaces) {
    try {
      const result = await runNightlyPush(workspace.id);
      if (result.conflicts.length > 0 || (!result.pushed && result.reason)) {
        degraded = true;
        console.warn(
          `SSR push-back workspace ${workspace.id}:`,
          result.reason ?? `${result.conflicts.length} conflicts`,
        );
      }
    } catch (error) {
      degraded = true;
      console.error(`SSR push-back workspace ${workspace.id} failed`, error);
    }
  }
  return { degraded };
}
