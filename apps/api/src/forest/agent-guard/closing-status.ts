import { and, eq } from "drizzle-orm";
import db from "../../database";
import { columnTable } from "../../database/schema";

type Reader = Pick<typeof db, "select">;

// A status closes a card when its column is final («готово»), or when it is
// the virtual «archived», which hides the card the same way (R-022).
export async function isClosingStatus(
  projectId: string,
  status: string,
  reader: Reader = db,
): Promise<boolean> {
  if (status === "archived") return true;
  const [column] = await reader
    .select({ isFinal: columnTable.isFinal })
    .from(columnTable)
    .where(
      and(eq(columnTable.projectId, projectId), eq(columnTable.slug, status)),
    )
    .limit(1);
  return column?.isFinal ?? false;
}
