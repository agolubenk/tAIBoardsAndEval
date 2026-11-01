import { and, eq } from "drizzle-orm";
import db from "../database";
import { columnTable } from "../database/schema";

// One-time rename (owner, 31.10): the closed column is now the timber yard —
// «Брёвна». The display name changes for every project that still carries the
// old label; the slug stays "closed" so cards, slugs and integrations are
// untouched. Idempotent: nothing to do once renamed.
export async function migrateBrevnaColumns() {
  const renamed = await db
    .update(columnTable)
    .set({ name: "Брёвна" })
    .where(and(eq(columnTable.slug, "closed"), eq(columnTable.name, "Closed")))
    .returning({ id: columnTable.id });
  if (renamed.length > 0) {
    console.log(`🪵 Renamed ${renamed.length} closed column(s) to «Брёвна»`);
  }
}
