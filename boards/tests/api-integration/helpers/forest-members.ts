import { randomUUID } from "node:crypto";
import db, { schema } from "../../../apps/api/src/database";
import { createApp } from "../../../apps/api/src/index";
import { mockAuthenticatedSession } from "./auth";

// A member who opens only the projects granted to them.
export async function addRestrictedMember(workspaceId: string) {
  const [user] = await db
    .insert(schema.userTable)
    .values({
      id: `user-${randomUUID()}`,
      email: `${randomUUID()}@example.com`,
      emailVerified: true,
      name: "Restricted",
    })
    .returning();
  if (!user) throw new Error("user not created");
  await db.insert(schema.workspaceUserTable).values({
    workspaceId,
    userId: user.id,
    role: "member",
    joinedAt: new Date(),
  });
  await db.insert(schema.workspaceMemberAccessTable).values({
    workspaceId,
    userId: user.id,
    projectAccess: "selected",
  });
  return user;
}

export function asMember(user: typeof schema.userTable.$inferSelect) {
  return async (path: string) => {
    mockAuthenticatedSession(user);
    const { app } = createApp();
    const response = await app.request(`/api${path}`);
    return { status: response.status, body: await response.json() };
  };
}
