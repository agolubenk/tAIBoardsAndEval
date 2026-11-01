import { and, eq, notInArray } from "drizzle-orm";
import { schema } from "../database";
import type { DbOrTx } from "../project-access/db-or-tx";
import { agentWorkspaceRole } from "./agent-workspace-role";

export type MirrorChanges = { joined: string[]; left: string[] };

// Copies the owner's memberships, workspace roles and project access onto the
// agent, and drops the agent from workspaces the owner has left. Returns the
// workspaces the agent joined and left, for the usual follow-ups.
export async function mirrorMemberships(
  tx: DbOrTx,
  ownerId: string,
  agentId: string,
): Promise<MirrorChanges> {
  const ownerMembers = await tx
    .select({
      workspaceId: schema.workspaceUserTable.workspaceId,
      role: schema.workspaceUserTable.role,
    })
    .from(schema.workspaceUserTable)
    .where(eq(schema.workspaceUserTable.userId, ownerId));
  const workspaceIds = ownerMembers.map((m) => m.workspaceId);

  const left = and(
    eq(schema.workspaceUserTable.userId, agentId),
    workspaceIds.length
      ? notInArray(schema.workspaceUserTable.workspaceId, workspaceIds)
      : undefined,
  );
  const leftRows = await tx
    .delete(schema.workspaceUserTable)
    .where(left)
    .returning({ workspaceId: schema.workspaceUserTable.workspaceId });

  const agentMembers = await tx
    .select({
      id: schema.workspaceUserTable.id,
      workspaceId: schema.workspaceUserTable.workspaceId,
      role: schema.workspaceUserTable.role,
    })
    .from(schema.workspaceUserTable)
    .where(eq(schema.workspaceUserTable.userId, agentId));
  const existing = new Map(agentMembers.map((m) => [m.workspaceId, m]));

  const joined: string[] = [];
  for (const { workspaceId, role } of ownerMembers) {
    const agentRole = agentWorkspaceRole(role);
    const current = existing.get(workspaceId);
    if (!current) {
      await tx.insert(schema.workspaceUserTable).values({
        workspaceId,
        userId: agentId,
        role: agentRole,
        joinedAt: new Date(),
      });
      joined.push(workspaceId);
    } else if (current.role !== agentRole) {
      await tx
        .update(schema.workspaceUserTable)
        .set({ role: agentRole })
        .where(eq(schema.workspaceUserTable.id, current.id));
    }
  }

  await mirrorProjectAccess(tx, ownerId, agentId);
  return { joined, left: leftRows.map((row) => row.workspaceId) };
}

// Project access is per workspace: "all" or a list of projects. The agent's
// rows are replaced by the owner's, so a project the owner lost goes too.
async function mirrorProjectAccess(
  tx: DbOrTx,
  ownerId: string,
  agentId: string,
) {
  await tx
    .delete(schema.workspaceMemberProjectTable)
    .where(eq(schema.workspaceMemberProjectTable.userId, agentId));
  await tx
    .delete(schema.workspaceMemberAccessTable)
    .where(eq(schema.workspaceMemberAccessTable.userId, agentId));

  const access = await tx
    .select({
      workspaceId: schema.workspaceMemberAccessTable.workspaceId,
      projectAccess: schema.workspaceMemberAccessTable.projectAccess,
    })
    .from(schema.workspaceMemberAccessTable)
    .where(eq(schema.workspaceMemberAccessTable.userId, ownerId));
  if (access.length) {
    await tx
      .insert(schema.workspaceMemberAccessTable)
      .values(access.map((row) => ({ ...row, userId: agentId })));
  }

  const projects = await tx
    .select({
      workspaceId: schema.workspaceMemberProjectTable.workspaceId,
      projectId: schema.workspaceMemberProjectTable.projectId,
    })
    .from(schema.workspaceMemberProjectTable)
    .where(eq(schema.workspaceMemberProjectTable.userId, ownerId));
  if (projects.length) {
    await tx
      .insert(schema.workspaceMemberProjectTable)
      .values(projects.map((row) => ({ ...row, userId: agentId })));
  }
}
