import {
  isPipelineEnabled,
  normalizePipelineSettings,
  type PipelineSettings,
  type PipelineToggle,
} from "@kaneo/permissions";
import { eq } from "drizzle-orm";
import db, { schema } from "../database";

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type StoredPipelineSettings = PipelineSettings & {
  updatedAt: Date | null;
  updatedBy: string | null;
};

function parse(value: string | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null; // a broken row falls back to the defaults instead of failing every read
  }
}

export async function readPipelineSettings(
  workspaceId: string,
  executor: Executor = db,
): Promise<StoredPipelineSettings> {
  const [row] = await executor
    .select()
    .from(schema.workspacePipelineSettingTable)
    .where(eq(schema.workspacePipelineSettingTable.workspaceId, workspaceId))
    .limit(1);
  return {
    ...normalizePipelineSettings(parse(row?.value)),
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy ?? null,
  };
}

export type PipelineSettingsPatch = {
  automation?: boolean;
  toggles?: Partial<PipelineSettings["toggles"]>;
};

// Read, merge and write under a row lock: two people switching different parts
// at the same moment both keep their change.
export async function updatePipelineSettings(
  workspaceId: string,
  patch: PipelineSettingsPatch,
  userId: string,
): Promise<StoredPipelineSettings> {
  await db.transaction(async (tx) => {
    // A first save has no row to lock yet: create it (defaults), then lock it.
    await tx
      .insert(schema.workspacePipelineSettingTable)
      .values({
        workspaceId,
        value: JSON.stringify(normalizePipelineSettings(null)),
        updatedBy: userId,
      })
      .onConflictDoNothing();
    const [row] = await tx
      .select()
      .from(schema.workspacePipelineSettingTable)
      .where(eq(schema.workspacePipelineSettingTable.workspaceId, workspaceId))
      .for("update");
    const current = normalizePipelineSettings(parse(row?.value));
    const next = normalizePipelineSettings({
      automation: patch.automation ?? current.automation,
      toggles: { ...current.toggles, ...patch.toggles },
    });
    await tx
      .update(schema.workspacePipelineSettingTable)
      .set({
        value: JSON.stringify(next),
        updatedBy: userId,
        updatedAt: new Date(),
      })
      .where(eq(schema.workspacePipelineSettingTable.workspaceId, workspaceId));
  });
  return readPipelineSettings(workspaceId);
}

// For server-side automation: is this part of the process on for the workspace?
export async function pipelineEnabled(
  workspaceId: string,
  name: PipelineToggle,
  executor: Executor = db,
): Promise<boolean> {
  return isPipelineEnabled(
    await readPipelineSettings(workspaceId, executor),
    name,
  );
}
