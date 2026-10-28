// t-boards: seeds the single local admin (login "admin", password "admin",
// spec R-006). The password is short on purpose and lives only as a bcrypt
// hash in the database, never in env. Sign-up enforces 8+ characters, so the
// account is written directly. Idempotent; refuses to run in cloud mode.
// The web login field maps "admin" to this email
// (apps/web/src/components/auth/local-admin-login.ts).
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import db, { getDatabasePool, schema } from "../src/database";
import { promoteInitialAdministrator } from "../src/utils/instance-bootstrap";
import { isCloud } from "../src/utils/is-cloud";

const LOCAL_ADMIN_EMAIL = "admin@t-boards.local";
const LOCAL_ADMIN_PASSWORD = "admin";

if (isCloud()) {
  throw new Error("seed-local-admin is for local instances only");
}

const [existing] = await db
  .select({ id: schema.userTable.id, role: schema.userTable.role })
  .from(schema.userTable)
  .where(eq(schema.userTable.email, LOCAL_ADMIN_EMAIL))
  .limit(1);

if (existing) {
  console.log(`local admin exists (${existing.id}, role=${existing.role})`);
} else {
  const passwordHash = await bcrypt.hash(LOCAL_ADMIN_PASSWORD, 10);
  const userId = await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(schema.userTable)
      .values({
        name: "admin",
        email: LOCAL_ADMIN_EMAIL,
        emailVerified: true,
        locale: "ru-RU",
      })
      .returning({ id: schema.userTable.id });
    if (!user) throw new Error("local admin insert returned no row");
    await tx.insert(schema.accountTable).values({
      accountId: user.id,
      providerId: "credential",
      userId: user.id,
      password: passwordHash,
    });
    return user.id;
  });
  await promoteInitialAdministrator(userId);
  console.log(`local admin created (${userId})`);
}

await getDatabasePool().end();
