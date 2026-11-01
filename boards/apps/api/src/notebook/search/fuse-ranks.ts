export const RRF_K = 60;

export type RankedList<B extends string = string> = { by: B; ids: string[] };

export type FusedHit<B extends string = string> = {
  id: string;
  score: number;
  matchedBy: B[];
};

// Reciprocal rank fusion: ranks, not raw scores, so cosine and ts_rank need
// no common scale. A hit both lists agree on outranks a lone first place.
export function fuseRanks<B extends string>(
  lists: RankedList<B>[],
  k = RRF_K,
): FusedHit<B>[] {
  const hits = new Map<string, FusedHit<B>>();
  for (const list of lists) {
    list.ids.forEach((id, rank) => {
      const hit = hits.get(id) ?? { id, score: 0, matchedBy: [] };
      hit.score += 1 / (k + rank + 1);
      if (!hit.matchedBy.includes(list.by)) hit.matchedBy.push(list.by);
      hits.set(id, hit);
    });
  }
  return [...hits.values()].sort((a, b) => b.score - a.score);
}
