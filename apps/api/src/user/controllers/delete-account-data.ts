import { APIError } from "better-auth/api";
import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { deleteOwnerAgents } from "../../agent-identity/owner-agents";
import {
  findBillableWorkspaces,
  formatBillableWorkspacesMessage,
} from "../../billing/controllers/find-billable-workspaces";
import { syncWorkspaceSeats } from "../../billing/controllers/sync-seats";
import db from "../../database";
import { revokeWorkspaceConnections } from "../../ws";
import {
  userTable,
  workspaceTable,
  workspaceUserTable,
} from "../../database/schema";
import { instanceAdminRoleSql } from "../../utils/instance-admin-role";
import {
  formatBlockedWorkspacesMessage,
  hasOwnerRole,
  planAccountDeletion,
  type WorkspaceMembershipSummary,
} from "../account-deletion";

async function collectMemberships(
  userId: string,
): Promise<WorkspaceMembershipSummary[]> {
  const memberships = await db
    .select({
      workspaceId: workspaceUserTable.workspaceId,
      role: workspaceUserTable.role,
    })
    .from(workspaceUserTable)
    .where(eq(workspaceUserTable.userId, userId));

  if (memberships.length === 0) {
    return [];
  }

  const workspaceIds = memberships.map((membership) => membership.workspaceId);

  const members = await db
    .select({
      workspaceId: workspaceUserTable.workspaceId,
      workspaceName: workspaceTable.name,
      role: workspaceUserTable.role,
    })
    .from(workspaceUserTable)
    .innerJoin(
      workspaceTable,
      eq(workspaceUserTable.workspaceId, workspaceTable.id),
    )
    // R-010: agents act for members and leave with them; they are not the
    // people a workspace would be handed to.
    .innerJoin(userTable, eq(userTable.id, workspaceUserTable.userId))
    .where(
      and(
        inArray(workspaceUserTable.workspaceId, workspaceIds),
        or(isNull(userTable.role), ne(userTable.role, "agent")),
      ),
    );

  return memberships.map((membership) => {
    const workspaceMembers = members.filter(
      (member) => member.workspaceId === membership.workspaceId,
    );

    return {
      workspaceId: membership.workspaceId,
      workspaceName: workspaceMembers[0]?.workspaceName ?? "workspace",
      isOwner: hasOwnerRole(membership.role),
      memberCount: workspaceMembers.length,
      ownerCount: workspaceMembers.filter((member) => hasOwnerRole(member.role))
        .length,
    };
  });
}

export async function deleteAccountData(userId: string) {
  const plan = planAccountDeletion(await collectMemberships(userId));

  if (plan.blockedWorkspaceNames.length > 0) {
    throw new APIError("CONFLICT", {
      code: "SOLE_WORKSPACE_OWNER",
      message: formatBlockedWorkspacesMessage(plan.blockedWorkspaceNames),
    });
  }

  const billable = await findBillableWorkspaces(plan.workspaceIdsToDelete);
  if (billable.length > 0) {
    throw new APIError("CONFLICT", {
      code: "WORKSPACE_HAS_ACTIVE_SUBSCRIPTION",
      message: formatBillableWorkspacesMessage(
        billable.map((workspace) => workspace.name),
      ),
    });
  }

  await deleteOwnerAgents(userId);

  if (plan.workspaceIdsToDelete.length > 0) {
    const admins = await db
      .select({ userId: userTable.id })
      .from(userTable)
      .where(instanceAdminRoleSql(userTable.role));
    const recipients = new Set([
      userId,
      ...admins.map((admin) => admin.userId),
    ]);
    await db
      .delete(workspaceTable)
      .where(inArray(workspaceTable.id, plan.workspaceIdsToDelete));
    for (const workspaceId of plan.workspaceIdsToDelete) {
      await Promise.all(
        [...recipients].map((recipient) =>
          revokeWorkspaceConnections(recipient, workspaceId, { force: true }),
        ),
      );
    }
  }

  if (plan.workspaceIdsToLeave.length > 0) {
    await db
      .delete(workspaceUserTable)
      .where(
        and(
          eq(workspaceUserTable.userId, userId),
          inArray(workspaceUserTable.workspaceId, plan.workspaceIdsToLeave),
        ),
      );

    for (const workspaceId of plan.workspaceIdsToLeave) {
      await syncWorkspaceSeats(workspaceId).catch((error) => {
        console.error(
          "Seat sync after account deletion failed:",
          workspaceId,
          error,
        );
      });
    }
  }

  for (const workspaceId of plan.workspaceIdsToLeave) {
    await revokeWorkspaceConnections(userId, workspaceId, { force: true });
  }

  return plan;
}

export default deleteAccountData;
