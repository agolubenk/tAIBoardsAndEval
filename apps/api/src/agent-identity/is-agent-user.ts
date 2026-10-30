import { and, eq } from "drizzle-orm";
import db, { schema } from "../database";
import type { DbOrTx } from "../project-access/db-or-tx";

export const AGENT_FOLLOWS_OWNER =
  "An agent's role and project access follow its owner's; change the owner's instead";

export async function isAgentUser(userId: string, database: DbOrTx = db) {
  const [row] = await database
    .select({ id: schema.userTable.id })
    .from(schema.userTable)
    .where(
      and(eq(schema.userTable.id, userId), eq(schema.userTable.role, "agent")),
    )
    .limit(1);
  return Boolean(row);
}
