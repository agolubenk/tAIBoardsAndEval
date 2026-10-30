import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { signUpWithSession } from "./helpers/auth-session";
import { resetTestDatabase } from "./helpers/database";
import { readErrorBody } from "./helpers/error-body";

// TB-119 S-1(в): a key a person minted for themselves stays out of account
// management on /auth — its in-memory session is always "fresh", so a leaked
// key could otherwise delete the account, mint keys or sign the owner out.
describe("API integration: a person's API key on /auth", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  async function personWithKey() {
    const { app } = createApp();
    const owner = await signUpWithSession(app, {
      email: `${randomUUID()}@example.com`,
      name: "Key Owner",
    });
    const created = await app.request("/api/auth/api-key/create", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: owner.cookies },
      body: JSON.stringify({ name: "Script" }),
    });
    expect(created.status).toBe(200);
    const { key } = (await created.json()) as { key: string };
    return { app, ...owner, key };
  }

  const viaHeader = (key: string) => ({ "x-api-key": key });
  const viaBearer = (key: string) => ({ authorization: `Bearer ${key}` });

  async function expectSessionRequired(response: Response) {
    expect(response.status).toBe(403);
    expect((await readErrorBody(response)).code).toBe("SESSION_REQUIRED");
  }

  it.each([
    ["x-api-key", viaHeader],
    ["Bearer", viaBearer],
  ])("refuses delete-user to a key sent as %s", async (_, send) => {
    const { app, userId, key } = await personWithKey();

    await expectSessionRequired(
      await app.request("/api/auth/delete-user", {
        method: "POST",
        headers: { ...send(key), "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    const [user] = await db
      .select({ id: schema.userTable.id })
      .from(schema.userTable)
      .where(eq(schema.userTable.id, userId));
    expect(user?.id).toBe(userId);
  });

  it.each([
    ["x-api-key", viaHeader],
    ["Bearer", viaBearer],
  ])("refuses api-key/create to a key sent as %s", async (_, send) => {
    const { app, userId, key } = await personWithKey();

    await expectSessionRequired(
      await app.request("/api/auth/api-key/create", {
        method: "POST",
        headers: { ...send(key), "content-type": "application/json" },
        body: JSON.stringify({ name: "Minted by a key" }),
      }),
    );

    const keys = await db
      .select({ id: schema.apikeyTable.id })
      .from(schema.apikeyTable)
      .where(eq(schema.apikeyTable.referenceId, userId));
    expect(keys).toHaveLength(1);
  });

  it.each([
    ["x-api-key", viaHeader],
    ["Bearer", viaBearer],
  ])("refuses revoke-sessions to a key sent as %s", async (_, send) => {
    const { app, cookies, key } = await personWithKey();

    await expectSessionRequired(
      await app.request("/api/auth/revoke-sessions", {
        method: "POST",
        headers: { ...send(key), "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    const session = await app.request("/api/auth/get-session", {
      headers: { cookie: cookies },
    });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ user: {} });
  });

  it("answers a banned owner's key 401 before the route check", async () => {
    const { app, userId, key } = await personWithKey();
    await db
      .update(schema.userTable)
      .set({ banned: true })
      .where(eq(schema.userTable.id, userId));

    for (const send of [viaHeader, viaBearer]) {
      const response = await app.request("/api/auth/delete-user", {
        method: "POST",
        headers: { ...send(key), "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(401);
    }
  });

  it("still lets the key read its session and workspaces", async () => {
    const { app, userId, key } = await personWithKey();

    const session = await app.request("/api/auth/get-session", {
      headers: viaHeader(key),
    });
    expect(session.status).toBe(200);
    expect(((await session.json()) as { user?: { id: string } }).user?.id).toBe(
      userId,
    );

    for (const send of [viaHeader, viaBearer]) {
      // A Bearer key reads get-session as null (the MCP asks /api/user/me
      // instead); the route still has to pass the allowlist.
      expect(
        (await app.request("/api/auth/get-session", { headers: send(key) }))
          .status,
      ).toBe(200);

      const workspaces = await app.request("/api/auth/organization/list", {
        headers: send(key),
      });
      expect(workspaces.status).toBe(200);
    }
  });

  it("leaves password sign-in and the cookie session as they were", async () => {
    // personWithKey signs in with the password and mints the key on the cookie.
    const { app, cookies, key } = await personWithKey();

    const second = await app.request("/api/auth/api-key/create", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookies },
      body: JSON.stringify({ name: "Second" }),
    });
    expect(second.status).toBe(200);

    const listed = await app.request("/api/auth/api-key/list", {
      headers: { cookie: cookies },
    });
    expect(listed.status).toBe(200);
    expect(key).toBeTruthy();
  });
});
