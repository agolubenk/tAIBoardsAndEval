import { eq } from "drizzle-orm";
import { z } from "zod";
import db, { schema } from "../database";

const SETTING_KEY = "notebook.model";

// Instance-wide (R-052, TB-67): one model key for every product on the
// server. Unset fields fall back to the server's environment.
export const storedNotebookModelSchema = z.object({
  baseUrl: z.string().url().optional(),
  model: z.string().min(1).optional(),
  embedModel: z.string().min(1).optional(),
  dailyMax: z.number().int().min(0).optional(),
  // Sealed with the server's settings key, never plain.
  key: z.string().startsWith("enc:v1:").optional(),
});

export type StoredNotebookModel = z.infer<typeof storedNotebookModelSchema>;

export async function readStoredNotebookModel(): Promise<StoredNotebookModel> {
  const [row] = await db
    .select({ value: schema.instanceSettingTable.value })
    .from(schema.instanceSettingTable)
    .where(eq(schema.instanceSettingTable.key, SETTING_KEY))
    .limit(1);
  if (!row) return {};
  try {
    const parsed = storedNotebookModelSchema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export async function writeStoredNotebookModel(
  value: StoredNotebookModel,
  actorId: string | null,
) {
  const text = JSON.stringify(storedNotebookModelSchema.parse(value));
  await db
    .insert(schema.instanceSettingTable)
    .values({ key: SETTING_KEY, value: text, updatedBy: actorId })
    .onConflictDoUpdate({
      target: schema.instanceSettingTable.key,
      set: { value: text, updatedBy: actorId, updatedAt: new Date() },
    });
}
