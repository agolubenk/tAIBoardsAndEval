// Section sizes of the context pack (R-031): enough to pick up a card, small
// enough to fit the agent's budget; the rest comes from the section's own read.
export const CONTEXT_LIMITS = {
  comments: 20,
  relations: 20,
  history: 10,
  approvals: 10,
} as const;

export type ContextSection = keyof typeof CONTEXT_LIMITS;

// Rows are read one past the limit, so a cut is known without a count query.
export function capSection<T>(rows: T[], section: ContextSection) {
  const max = CONTEXT_LIMITS[section];
  return { items: rows.slice(0, max), cut: rows.length > max };
}

type RelatedTask = {
  id: string;
  number: number | null;
  title: string;
  status: string;
  isCompleted: boolean;
};

type Relation = {
  id: string;
  sourceTaskId: string;
  relationType: string;
  createdAt: Date;
  sourceTask: RelatedTask | null;
  targetTask: RelatedTask | null;
};

// The other end of each link, seen from the card: «blocks X» stays apart
// from «blocked by X».
export function toContextRelations(taskId: string, relations: Relation[]) {
  return relations.flatMap((relation) => {
    const outgoing = relation.sourceTaskId === taskId;
    const other = outgoing ? relation.targetTask : relation.sourceTask;
    if (!other) return [];
    const { id, number, title, status, isCompleted } = other;
    return [
      {
        id: relation.id,
        relationType: relation.relationType,
        direction: outgoing ? ("outgoing" as const) : ("incoming" as const),
        task: { id, number, title, status, isCompleted },
        createdAt: relation.createdAt,
      },
    ];
  });
}
