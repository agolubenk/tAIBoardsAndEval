export type PlacedTask = { columnId: string | null; status: string };

export function positionBucket({ columnId, status }: PlacedTask): string {
  return columnId ?? `status:${status}`;
}

// Mirrored cards that change column, and new ones, go to the end of it.
export function createPositionAllocator(
  maxima: ReadonlyArray<PlacedTask & { max: number | null }>,
) {
  const last = new Map<string, number>();
  for (const row of maxima) {
    const bucket = positionBucket(row);
    last.set(bucket, Math.max(last.get(bucket) ?? 0, row.max ?? 0));
  }
  return (task: PlacedTask): number => {
    const bucket = positionBucket(task);
    const next = (last.get(bucket) ?? 0) + 1;
    last.set(bucket, next);
    return next;
  };
}
