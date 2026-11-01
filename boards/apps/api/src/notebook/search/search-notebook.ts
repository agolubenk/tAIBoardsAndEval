import { and, eq, inArray, sql } from "drizzle-orm";
import db from "../../database";
import {
  type NotebookSourceKind,
  notebookChunkTable,
  notebookSourceTable,
} from "../../database/notebook-schema";
import { isWorkerOnline, requestQueryEmbedding } from "../embed/embed-queue";
import { decodeEmbedding } from "../embed/embedding-codec";
import { notebookEmbedModel } from "../notebook-config";
import { fuseRanks, type RankedList } from "./fuse-ranks";
import { loadVectorIndex, nearestChunks } from "./vector-index";

const CANDIDATES = 20;
// Longer than one worker batch, short enough that a stuck worker costs the
// reader a few seconds of keyword-only results, not a hang.
export const QUERY_EMBED_WAIT_MS = 4_000;

export type SearchMode = "hybrid" | "keyword";
type MatchedBy = "vector" | "keyword";

export type NotebookHit = {
  chunkId: string;
  source: { kind: NotebookSourceKind; ref: string; title: string };
  heading: string;
  text: string;
  score: number;
  matchedBy: MatchedBy[];
};

export async function searchNotebook(input: {
  workspaceId: string;
  query: string;
  limit: number;
  mode: SearchMode;
}): Promise<{ mode: SearchMode; results: NotebookHit[] }> {
  const wantVectors =
    input.mode === "hybrid" && isWorkerOnline(input.workspaceId);
  const [keywordIds, vectorIds] = await Promise.all([
    keywordCandidates(input.workspaceId, input.query),
    wantVectors
      ? vectorCandidates(input.workspaceId, input.query)
      : Promise.resolve(null),
  ]);
  const lists: RankedList<MatchedBy>[] = [{ by: "keyword", ids: keywordIds }];
  if (vectorIds) lists.unshift({ by: "vector", ids: vectorIds });
  const fused = fuseRanks(lists).slice(0, input.limit);
  const rows = await loadHits(
    input.workspaceId,
    fused.map(({ id }) => id),
  );
  const byId = new Map(rows.map((row) => [row.chunkId, row]));
  const results = fused.flatMap((hit) => {
    const row = byId.get(hit.id);
    return row ? [{ ...row, score: hit.score, matchedBy: hit.matchedBy }] : [];
  });
  return { mode: vectorIds ? "hybrid" : "keyword", results };
}

async function keywordCandidates(workspaceId: string, query: string) {
  const tsquery = sql`websearch_to_tsquery('russian', ${query})`;
  const rows = await db
    .select({ id: notebookChunkTable.id })
    .from(notebookChunkTable)
    .where(
      and(
        eq(notebookChunkTable.workspaceId, workspaceId),
        sql`${notebookChunkTable.search} @@ ${tsquery}`,
      ),
    )
    .orderBy(sql`ts_rank(${notebookChunkTable.search}, ${tsquery}) desc`)
    .limit(CANDIDATES);
  return rows.map(({ id }) => id);
}

// Null means no vector ranking this time; the caller says so in `mode`.
async function vectorCandidates(workspaceId: string, query: string) {
  const vector = await requestQueryEmbedding(
    workspaceId,
    query,
    QUERY_EMBED_WAIT_MS,
  );
  if (!vector) return null;
  const index = await loadVectorIndex(workspaceId, notebookEmbedModel());
  if (!index) return null;
  return nearestChunks(index, decodeEmbedding(vector), CANDIDATES).map(
    ({ id }) => id,
  );
}

async function loadHits(workspaceId: string, ids: string[]) {
  if (!ids.length) return [];
  const rows = await db
    .select({
      chunkId: notebookChunkTable.id,
      heading: notebookChunkTable.heading,
      text: notebookChunkTable.text,
      kind: notebookSourceTable.kind,
      ref: notebookSourceTable.ref,
      title: notebookSourceTable.title,
    })
    .from(notebookChunkTable)
    .innerJoin(
      notebookSourceTable,
      eq(notebookSourceTable.id, notebookChunkTable.sourceId),
    )
    .where(
      and(
        eq(notebookChunkTable.workspaceId, workspaceId),
        inArray(notebookChunkTable.id, ids),
      ),
    );
  return rows.map(({ kind, ref, title, ...row }) => ({
    ...row,
    source: { kind, ref, title },
  }));
}
