import { and, count, eq, isNull, ne, or } from "drizzle-orm";
import db from "../../database";
import {
  userTable,
  workspaceBillingTable,
  workspaceUserTable,
} from "../../database/schema";
import { isBillingEnabled } from "../config";
import { updateSubscriptionSeats } from "../creem-client";

export async function syncWorkspaceSeats(workspaceId: string) {
  if (!isBillingEnabled()) {
    return;
  }

  const [billing] = await db
    .select()
    .from(workspaceBillingTable)
    .where(eq(workspaceBillingTable.workspaceId, workspaceId));

  if (
    !billing?.creemSubscriptionId ||
    !billing.creemProductId ||
    billing.plan !== "team" ||
    (billing.status !== "active" && billing.status !== "trialing")
  ) {
    return;
  }

  // R-010: agents act for a member who already holds a seat.
  const [members] = await db
    .select({ value: count() })
    .from(workspaceUserTable)
    .innerJoin(userTable, eq(userTable.id, workspaceUserTable.userId))
    .where(
      and(
        eq(workspaceUserTable.workspaceId, workspaceId),
        or(isNull(userTable.role), ne(userTable.role, "agent")),
      ),
    );

  const seats = Math.max(1, members?.value ?? 1);
  if (seats === billing.seats) {
    return;
  }

  await updateSubscriptionSeats({
    subscriptionId: billing.creemSubscriptionId,
    productId: billing.creemProductId,
    units: seats,
  });

  await db
    .update(workspaceBillingTable)
    .set({ seats })
    .where(eq(workspaceBillingTable.workspaceId, workspaceId));
}
