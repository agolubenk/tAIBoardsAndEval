// The stages whose fields the server fills or asks for when an agent moves a
// card (owner, 30.10): work started and work handed to review. Projects with
// their own stages keep Kaneo's slugs for these two.
export type CardStage = "started" | "review";

export function cardStage(status: string): CardStage | null {
  if (status === "in-progress") return "started";
  if (status === "in-review") return "review";
  return null;
}
