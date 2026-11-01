import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { projectTable } from "../../database/schema";
import type {
  WriteImportedProjectInput,
  WrittenImportProject,
} from "../write-imported-project";
import { createImportProject } from "../writer/create-import-project";
import { writeProjectContent } from "../writer/write-project-content";
import { loadMirroredCards } from "./load-mirrored-cards";
import { notionMetaRows } from "./notion-meta-rows";
import { planNotionSync } from "./plan-notion-sync";
import { syncNotionProject } from "./sync-notion-project";
import { writeNotionCardMeta } from "./write-notion-card-meta";

// The first import of a Notion database creates its project; every later one
// syncs into the project its cards already live in (R-080).
export async function writeNotionProject(
  input: WriteImportedProjectInput,
): Promise<WrittenImportProject> {
  const { workspaceId, project } = input;
  const pageIds = project.tasks.flatMap((task) =>
    task.sourceRef ? [task.sourceRef.pageId] : [],
  );
  const cards = await loadMirroredCards(pageIds);
  const foreign = cards.filter((card) => card.workspaceId !== workspaceId);
  if (foreign.length > 0) {
    throw new HTTPException(409, {
      message: `${foreign.length === 1 ? "A page" : `${foreign.length} pages`} of this database already mirror into another workspace. Import the database there.`,
    });
  }

  const plan = planNotionSync(project.tasks, cards);
  if (plan.projectId === null) return createMirror(input);

  const projectId = plan.projectId;
  const synced = await db.transaction((tx) =>
    syncNotionProject(tx, { ...input, projectId, plan }),
  );
  const [row] = await db
    .select({ slug: projectTable.slug })
    .from(projectTable)
    .where(eq(projectTable.id, projectId));
  return { projectId, projectSlug: row?.slug ?? "", ...synced };
}

function createMirror(input: WriteImportedProjectInput) {
  const { workspaceId, userId, project } = input;
  return createImportProject(
    {
      workspaceId,
      name: project.name.trim() || "Untitled project",
      userId,
      preferredKey: project.key,
    },
    async (tx, created) => {
      const { taskIds, counts, warnings } = await writeProjectContent(tx, {
        ...input,
        projectId: created.id,
      });
      const metaWarnings = await writeNotionCardMeta(tx, {
        workspaceId,
        userId,
        rows: notionMetaRows(project.tasks, taskIds),
      });
      return {
        projectId: created.id,
        projectSlug: created.slug,
        counts,
        warnings: [...warnings, ...metaWarnings],
      };
    },
  );
}
