export type CardRefs = { files: string[]; decisions: string[] };

// Cards in order while the page's node budget lasts: a card costs itself and
// each file or decision the page does not carry yet. The first card always
// fits, so a page is never empty and the cursor always moves.
export function fitNodeBudget<T extends CardRefs>(cards: T[], budget: number) {
  const carried = new Set<string>();
  const picked: T[] = [];
  for (const card of cards) {
    const fresh = [
      ...card.files.map((path) => `file:${path}`),
      ...card.decisions.map((ref) => `decision:${ref}`),
    ].filter((key) => !carried.has(key));
    const nodes = picked.length + carried.size + 1 + fresh.length;
    if (picked.length && nodes > budget) break;
    picked.push(card);
    for (const key of fresh) carried.add(key);
  }
  return picked;
}
