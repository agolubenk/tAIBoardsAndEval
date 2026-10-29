export type CardSourceRow = {
  id: string;
  number: number | null;
  title: string;
  status: string;
  priority: string;
  description: string | null;
  projectSlug: string;
  projectName: string;
  kind: string | null;
  severity: string | null;
  backlogId: string | null;
  halfBaked: boolean | null;
  report: string | null;
};

// A card is one source: its ticket key and title as the top heading, the
// fields a reader filters by on one line, then the description and report as
// written. Descriptions are Markdown, so their own headings become chunks.
export const CARD_TEXT_MAX = 100_000;

export function cardSourceTitle(card: CardSourceRow) {
  const key =
    card.number == null
      ? card.projectSlug
      : `${card.projectSlug}-${card.number}`;
  return `${key.toUpperCase()} ${card.title}`;
}

export function cardSourceText(card: CardSourceRow) {
  const fields = [
    `project: ${card.projectName}`,
    `status: ${card.status}`,
    `priority: ${card.priority}`,
    card.kind === "bug" ? "kind: bug" : null,
    card.severity ? `severity: ${card.severity}` : null,
    card.backlogId ? `backlog: ${card.backlogId}` : null,
    card.halfBaked ? "half-baked: yes" : null,
  ].filter(Boolean);
  const blocks = [`# ${cardSourceTitle(card)}`, fields.join(" · ")];
  const description = card.description?.trim();
  if (description) blocks.push(description);
  const report = card.report?.trim();
  if (report) blocks.push(`## Report\n\n${report}`);
  return blocks.join("\n\n").slice(0, CARD_TEXT_MAX);
}
