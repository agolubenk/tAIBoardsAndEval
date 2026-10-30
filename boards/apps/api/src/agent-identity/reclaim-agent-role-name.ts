import { AGENT_ROLE_NAME, defaultRolePayloads } from "@kaneo/permissions";
import { and, eq, like, ne, sql } from "drizzle-orm";
import db, { schema } from "../database";
import { splitRoles } from "../utils/split-roles";
import { namesAgentRole } from "./agent-role-guard";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const RENAMED = "custom-agent";

// Nobody may edit the agent role, so its permissions are always the built-in
// ones. A workspace that made its own role named "agent" before the name was
// reserved keeps it under another name for the people who hold it, so nobody
// gains or loses a right; agents get the built-in role. With nobody but agents
// on it the row is simply reset, which also carries a change of the built-in
// set to old workspaces.
export async function reclaimAgentRoleName() {
  const permission = JSON.stringify(defaultRolePayloads[AGENT_ROLE_NAME]);
  const stale = await db
    .select({
      id: schema.workspaceRoleTable.id,
      workspaceId: schema.workspaceRoleTable.workspaceId,
    })
    .from(schema.workspaceRoleTable)
    .where(
      and(
        eq(schema.workspaceRoleTable.role, AGENT_ROLE_NAME),
        ne(schema.workspaceRoleTable.permission, permission),
      ),
    );
  for (const row of stale) {
    await db.transaction((tx) => reclaimRow(tx, row, permission));
  }
  if (stale.length) {
    console.log(`✅ Reclaimed the agent role in ${stale.length} workspace(s).`);
  }
  return stale.length;
}

async function reclaimRow(
  tx: Tx,
  row: { id: string; workspaceId: string },
  permission: string,
) {
  const now = new Date();
  const people = await peopleOnAgentRole(tx, row.workspaceId);
  const invitations = await tx
    .select({
      id: schema.invitationTable.id,
      role: schema.invitationTable.role,
    })
    .from(schema.invitationTable)
    .where(
      and(
        eq(schema.invitationTable.workspaceId, row.workspaceId),
        eq(schema.invitationTable.status, "pending"),
        like(schema.invitationTable.role, `%${AGENT_ROLE_NAME}%`),
      ),
    );
  const invited = invitations.filter((i) => namesAgentRole(i.role));
  if (!people.length && !invited.length) {
    await tx
      .update(schema.workspaceRoleTable)
      .set({ permission, updatedAt: now })
      .where(eq(schema.workspaceRoleTable.id, row.id));
    return;
  }

  const name = await freeRoleName(tx, row.workspaceId);
  await tx
    .update(schema.workspaceRoleTable)
    .set({ role: name, updatedAt: now })
    .where(eq(schema.workspaceRoleTable.id, row.id));
  for (const person of people) {
    await tx
      .update(schema.workspaceUserTable)
      .set({ role: renameRole(person.role, name) })
      .where(eq(schema.workspaceUserTable.id, person.id));
  }
  for (const invitation of invited) {
    await tx
      .update(schema.invitationTable)
      .set({ role: renameRole(invitation.role, name) })
      .where(eq(schema.invitationTable.id, invitation.id));
  }
  await tx.insert(schema.workspaceRoleTable).values({
    workspaceId: row.workspaceId,
    role: AGENT_ROLE_NAME,
    permission,
    createdAt: now,
    updatedAt: now,
  });
}

async function peopleOnAgentRole(tx: Tx, workspaceId: string) {
  const rows = await tx
    .select({
      id: schema.workspaceUserTable.id,
      role: schema.workspaceUserTable.role,
    })
    .from(schema.workspaceUserTable)
    .innerJoin(
      schema.userTable,
      eq(schema.userTable.id, schema.workspaceUserTable.userId),
    )
    .where(
      and(
        eq(schema.workspaceUserTable.workspaceId, workspaceId),
        like(schema.workspaceUserTable.role, `%${AGENT_ROLE_NAME}%`),
        sql`${schema.userTable.role} is distinct from 'agent'`,
      ),
    );
  return rows.filter((row) => namesAgentRole(row.role));
}

async function freeRoleName(tx: Tx, workspaceId: string) {
  const rows = await tx
    .select({ role: schema.workspaceRoleTable.role })
    .from(schema.workspaceRoleTable)
    .where(
      and(
        eq(schema.workspaceRoleTable.workspaceId, workspaceId),
        like(schema.workspaceRoleTable.role, `${RENAMED}%`),
      ),
    );
  const taken = new Set(rows.map((r) => r.role));
  for (let i = 1; ; i++) {
    const name = i === 1 ? RENAMED : `${RENAMED}-${i}`;
    if (!taken.has(name)) return name;
  }
}

function renameRole(role: string | null, name: string) {
  return splitRoles(role)
    .map((r) => (r.toLowerCase() === AGENT_ROLE_NAME ? name : r))
    .join(",");
}
