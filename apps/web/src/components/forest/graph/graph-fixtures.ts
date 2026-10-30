import type { ForestGraphPage } from "../forest-types";

type Card = ForestGraphPage["cards"][number];

export function graphCard(id: string, overrides: Partial<Card> = {}): Card {
  return {
    id,
    number: null,
    title: `Card ${id}`,
    status: "to-do",
    isCompleted: false,
    isBug: false,
    projectId: "p1",
    projectName: "t-boards",
    sectorIds: [],
    ...overrides,
  };
}

export function graphPage(page: Partial<ForestGraphPage>): ForestGraphPage {
  return {
    cards: [],
    files: [],
    decisions: [],
    edges: [],
    sectors: [],
    nextCursor: null,
    ...page,
  };
}
