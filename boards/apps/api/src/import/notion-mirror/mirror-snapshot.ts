import {
  type ImportedProject,
  type ImportedTask,
  type NotionPage,
  notionTypeNameOf,
} from "@kaneo/importers";
import { planImportColumns } from "../writer/plan-import-columns";

export type MirrorCardRow = {
  taskId: string;
  title: string;
  status: string;
  columnSlug: string | null;
  notionPageId: string;
};

// The board as `reconcile` reads an import: each mirrored card becomes an
// ImportedTask whose column key is recovered from its column's slug. A card an
// agent or person moved to a column Notion has no status for keeps a
// `kaneo:` key, so it shows up as a status mismatch rather than vanishing.
export function snapshotTasks(
  rows: readonly MirrorCardRow[],
  project: ImportedProject,
  pages: readonly NotionPage[],
): ImportedTask[] {
  const keyBySlug = new Map(
    planImportColumns(project.columns).columns.map(({ slug, key }) => [
      slug,
      key,
    ]),
  );
  const expectedKey = new Map(
    project.tasks.flatMap((task) =>
      task.sourceRef ? [[task.sourceRef.pageId, task.columnKey] as const] : [],
    ),
  );
  const pageById = new Map(pages.map((page) => [page.id, page]));

  return rows.map((row): ImportedTask => {
    const archived = row.status === "archived";
    const slug = row.columnSlug ?? row.status;
    // An archived card has no column; its status is the archive itself.
    const columnKey = archived
      ? (expectedKey.get(row.notionPageId) ?? null)
      : (keyBySlug.get(slug) ?? `kaneo:${slug}`);
    const page = pageById.get(row.notionPageId);
    const type = page ? notionTypeNameOf(page) : undefined;
    return {
      key: `notion:${row.notionPageId}`,
      columnKey,
      archived,
      title: row.title,
      description: "",
      priority: "no-priority",
      labelKeys: [],
      comments: [],
      sourceRef: {
        system: "notion",
        pageId: row.notionPageId,
        lastEditedTime: "",
      },
      extraFields: type ? { Type: type } : {},
    };
  });
}
