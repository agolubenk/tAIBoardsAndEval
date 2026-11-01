import { and, eq, ne } from "drizzle-orm";
import db from "../../database";
import { externalLinkTable } from "../../database/schema";
import { ForestError } from "../forest-error";
import { LINK_HEADER } from "./card-fill-headers";

// A card goes to review with what to review: a PR, a commit or another link,
// sent with the move or already on the card. A branch alone is not one.
export async function assertReviewLink(taskId: string, link: string | null) {
  if (link) return;
  const [existing] = await db
    .select({ id: externalLinkTable.id })
    .from(externalLinkTable)
    .where(
      and(
        eq(externalLinkTable.taskId, taskId),
        ne(externalLinkTable.resourceType, "branch"),
      ),
    )
    .limit(1);
  if (existing) return;
  throw new ForestError(
    "card_incomplete",
    `a card goes to review with a link to the PR or commit: send it in ${LINK_HEADER} (MCP: link) or add it to the card first`,
  );
}
