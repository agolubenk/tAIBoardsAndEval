import type { ImportedProject, ImportSourceId } from "@kaneo/importers";
import { publishEvent } from "../events";
import type { ImportCounts } from "./import-run-project";
import { writeNotionProject } from "./notion-mirror/write-notion-project";
import { createImportProject } from "./writer/create-import-project";
import { writeProjectContent } from "./writer/write-project-content";

export type WriteImportedProjectInput = {
  workspaceId: string;
  userId: string;
  source: ImportSourceId;
  project: ImportedProject;
  includeComments: boolean;
};

export type WrittenImportProject = {
  projectId: string;
  projectSlug: string;
  counts: ImportCounts;
  warnings: string[];
};

export async function writeImportedProject(
  input: WriteImportedProjectInput,
): Promise<WrittenImportProject> {
  const written =
    input.source === "notion"
      ? await writeNotionProject(input)
      : await writeNewProject(input);

  await publishEvent("project.updated", { projectId: written.projectId });

  return written;
}

function writeNewProject({
  workspaceId,
  userId,
  source,
  project,
  includeComments,
}: WriteImportedProjectInput): Promise<WrittenImportProject> {
  return createImportProject(
    {
      workspaceId,
      name: project.name.trim() || "Untitled project",
      userId,
      preferredKey: project.key,
    },
    async (tx, created) => {
      // Task ids only matter to the Notion mirror; the run record keeps counts.
      const { taskIds: _taskIds, ...content } = await writeProjectContent(tx, {
        projectId: created.id,
        workspaceId,
        userId,
        source,
        project,
        includeComments,
      });
      return { projectId: created.id, projectSlug: created.slug, ...content };
    },
  );
}
