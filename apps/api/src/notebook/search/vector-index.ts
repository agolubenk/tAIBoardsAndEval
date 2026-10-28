import { and, eq, isNotNull, sql } from "drizzle-orm";
import db from "../../database";
import { notebookChunkTable } from "../../database/notebook-schema";
import { decodeEmbedding, dot, normalize } from "../embed/embedding-codec";

// One normalized matrix per workspace, rebuilt when the embedded set changes:
// 3k chunks of 768 dims are ~9 MB and a full scan is a few milliseconds.
export const VECTOR_ROWS_MAX = 20_000;
const CACHED_WORKSPACES_MAX = 8;

export type VectorIndex = {
  stamp: string;
  dims: number;
  ids: string[];
  matrix: Float32Array;
};

const cache = new Map<string, VectorIndex>();

const cacheKey = (workspaceId: string, model: string) =>
  `${workspaceId}\u0000${model}`;

export async function loadVectorIndex(
  workspaceId: string,
  model: string,
): Promise<VectorIndex | null> {
  const scope = and(
    eq(notebookChunkTable.workspaceId, workspaceId),
    eq(notebookChunkTable.embedModel, model),
    isNotNull(notebookChunkTable.embedding),
  );
  const [state] = await db
    .select({
      count: sql<number>`count(*)::int`,
      latest: sql<string | null>`max(${notebookChunkTable.embeddedAt})::text`,
    })
    .from(notebookChunkTable)
    .where(scope);
  if (!state?.count) return null;
  const stamp = `${state.count}:${state.latest}`;
  const key = cacheKey(workspaceId, model);
  const cached = cache.get(key);
  if (cached?.stamp === stamp) return cached;

  const rows = await db
    .select({
      id: notebookChunkTable.id,
      embedding: notebookChunkTable.embedding,
    })
    .from(notebookChunkTable)
    .where(scope)
    .limit(VECTOR_ROWS_MAX);
  const index = buildVectorIndex(stamp, rows);
  if (!index) return null;
  cache.delete(key);
  cache.set(key, index);
  if (cache.size > CACHED_WORKSPACES_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return index;
}

// Rows of another width (a half-finished model switch) are left out.
export function buildVectorIndex(
  stamp: string,
  rows: { id: string; embedding: Buffer | null }[],
): VectorIndex | null {
  const first = rows.find((row) => row.embedding);
  if (!first?.embedding) return null;
  const dims = first.embedding.length / 4;
  const usable = rows.filter((row) => row.embedding?.length === dims * 4);
  const matrix = new Float32Array(usable.length * dims);
  usable.forEach((row, i) => {
    matrix.set(normalize(decodeEmbedding(row.embedding as Buffer)), i * dims);
  });
  return { stamp, dims, ids: usable.map(({ id }) => id), matrix };
}

export function nearestChunks(
  index: VectorIndex,
  query: Float32Array,
  k: number,
): { id: string; score: number }[] {
  if (query.length !== index.dims) return [];
  const normalized = normalize(query);
  const scored = index.ids.map((id, i) => ({
    id,
    score: dot(normalized, index.matrix, i * index.dims),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

export function clearVectorCacheForTests() {
  cache.clear();
}
