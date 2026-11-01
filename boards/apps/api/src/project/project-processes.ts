// The board's process (owner, 29.10): a task is new, then grilled, then open
// or closed; open work goes through review to the owner's confirmation. A bug
// is a card of kind "bug" on the same board and in the same columns (owner,
// 30.10). Kaneo's four slugs keep their meaning ("to-do" is «Открыта»), so
// cards and integrations stay put. A final column closes a card, which an
// agent does only with the owner's «да» (agent-guard).
export const DEFAULT_PROJECT_COLUMNS = [
  { name: "New", slug: "new", position: 0, isFinal: false },
  { name: "Grilling", slug: "grilling", position: 1, isFinal: false },
  { name: "To Do", slug: "to-do", position: 2, isFinal: false },
  { name: "In Progress", slug: "in-progress", position: 3, isFinal: false },
  { name: "In Review", slug: "in-review", position: 4, isFinal: false },
  { name: "Confirmation", slug: "confirmation", position: 5, isFinal: false },
  { name: "Done", slug: "done", position: 6, isFinal: true },
  { name: "Брёвна", slug: "closed", position: 7, isFinal: true },
] as const;

// Past «На ревью» the card is the owner's: an agent moves it into or out of
// this stage only with the owner's «да», like a final column.
export const OWNER_STAGE_SLUGS: ReadonlySet<string> = new Set(["confirmation"]);
