import { eq } from "drizzle-orm";
import type db from "../../database";
import { columnTable, projectTable } from "../../database/schema";
import { grantProjectToRestrictedMember } from "../../project-access/grant-project-to-restricted-member";
import { PROJECT_PROCESSES, type ProjectProcess } from "../project-processes";
import {
  assertProjectKeyAvailable,
  lockProjectOrdering,
  nextProjectPosition,
} from "./project-placement";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type NewProject = {
  workspaceId: string;
  name: string;
  icon: string;
  slug: string;
  userId: string;
  process?: ProjectProcess;
};

export type ProjectPlacement = {
  workspaceId: string;
  projectId: string;
  slug: string;
};

async function seedDefaultColumns(
  tx: Transaction,
  projectId: string,
  process: ProjectProcess = "tasks",
) {
  for (const col of PROJECT_PROCESSES[process]) {
    await tx.insert(columnTable).values({
      projectId,
      name: col.name,
      slug: col.slug,
      position: col.position,
      isFinal: col.isFinal,
    });
  }
}

export async function insertProject(
  tx: Transaction,
  { workspaceId, name, icon, slug, userId, process }: NewProject,
) {
  // Serialize ordering writes per workspace: without this, two concurrent
  // creates can read the same max(position) and land on the same slot, and a
  // create can interleave with a reorder's renumber. `reorderProjects` takes
  // the same lock with the same key.
  await lockProjectOrdering(tx, workspaceId);
  await assertProjectKeyAvailable(tx, workspaceId, slug);

  // New projects go to the bottom of the workspace's ordering.
  const position = await nextProjectPosition(tx, workspaceId);

  const [createdProject] = await tx
    .insert(projectTable)
    .values({ workspaceId, name, icon, slug, position })
    .returning();

  if (createdProject) {
    await seedDefaultColumns(tx, createdProject.id, process);
    await grantProjectToRestrictedMember(tx, {
      workspaceId,
      userId,
      projectId: createdProject.id,
    });
  }

  return createdProject;
}

export async function insertUnplacedProject(
  tx: Transaction,
  { workspaceId, name, icon, slug, userId }: NewProject,
) {
  const [createdProject] = await tx
    .insert(projectTable)
    .values({ workspaceId, name, icon, slug, position: 0 })
    .returning();

  if (createdProject) {
    await seedDefaultColumns(tx, createdProject.id);
    await grantProjectToRestrictedMember(tx, {
      workspaceId,
      userId,
      projectId: createdProject.id,
    });
  }

  return createdProject;
}

export async function placeProject(
  tx: Transaction,
  { workspaceId, projectId, slug }: ProjectPlacement,
) {
  await lockProjectOrdering(tx, workspaceId);
  await assertProjectKeyAvailable(tx, workspaceId, slug, projectId);
  const position = await nextProjectPosition(tx, workspaceId, projectId);

  await tx
    .update(projectTable)
    .set({ position })
    .where(eq(projectTable.id, projectId));
}
