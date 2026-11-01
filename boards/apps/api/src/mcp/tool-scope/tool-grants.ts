import { createHash } from "node:crypto";
import { asc, eq, lt, sql } from "drizzle-orm";
import db from "../../database";
import { mcpToolGrantTable } from "../../database/forest-schema";
import { EXTRA_TOOLS_MAX } from "./roles";

// A grant outlives no bearer token: sessions expire well before this.
const stale = sql`(now() AT TIME ZONE 'utc') - interval '30 days'`;

export function grantSessionKey(role: string, token: string) {
  return `${role}:${createHash("sha256").update(token).digest("hex")}`;
}

export async function listGrants(sessionKey: string) {
  const rows = await db
    .select({ tool: mcpToolGrantTable.tool })
    .from(mcpToolGrantTable)
    .where(eq(mcpToolGrantTable.sessionKey, sessionKey))
    .orderBy(asc(mcpToolGrantTable.createdAt))
    .limit(EXTRA_TOOLS_MAX);
  return rows.map((row) => row.tool);
}

// Adds what still fits under the cap and returns everything the session now
// holds. The lock keeps two concurrent finds from passing the cap together.
export function grantTools(sessionKey: string, tools: string[]) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${sessionKey}))`,
    );
    await tx
      .delete(mcpToolGrantTable)
      .where(lt(mcpToolGrantTable.createdAt, stale));
    const held = (
      await tx
        .select({ tool: mcpToolGrantTable.tool })
        .from(mcpToolGrantTable)
        .where(eq(mcpToolGrantTable.sessionKey, sessionKey))
        .orderBy(asc(mcpToolGrantTable.createdAt))
        .limit(EXTRA_TOOLS_MAX)
    ).map((row) => row.tool);
    const room = Math.max(EXTRA_TOOLS_MAX - held.length, 0);
    const fresh = tools.filter((tool) => !held.includes(tool)).slice(0, room);
    if (fresh.length > 0) {
      await tx
        .insert(mcpToolGrantTable)
        .values(fresh.map((tool) => ({ sessionKey, tool })))
        .onConflictDoNothing();
    }
    return [...held, ...fresh];
  });
}
