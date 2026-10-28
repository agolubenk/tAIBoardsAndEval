import { describe, expect, it } from "vite-plus/test";
import {
  type CardBinding,
  matchObservationToCards,
  type ObservationLike,
} from "./bind.js";

function observation(
  overrides: Partial<ObservationLike> = {},
): ObservationLike {
  return {
    id: 1,
    memorySessionId: "mem-1",
    project: "synthetic-project",
    platformSource: "claude",
    type: "discovery",
    title: null,
    subtitle: null,
    narrative: null,
    text: null,
    facts: [],
    concepts: [],
    filesRead: [],
    filesModified: [],
    promptNumber: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    createdAtEpoch: 1767225600000,
    ...overrides,
  };
}

const CARD_K5: CardBinding = {
  cardId: "K-5",
  branch: "kimi/k5-claude-mem",
  identifiers: ["K-5"],
};

describe("matchObservationToCards", () => {
  it("matches a branch from metadata exactly", () => {
    const obs = observation({
      metadata: { branch: "kimi/k5-claude-mem" },
    });

    const matches = matchObservationToCards(obs, [CARD_K5]);

    expect(matches).toEqual([
      {
        observationId: 1,
        cardId: "K-5",
        matchedOn: "branch",
        matchedValue: "kimi/k5-claude-mem",
        source: "metadata",
      },
    ]);
  });

  it("matches a task id from metadata keys like task_id / cardId", () => {
    const obs = observation({ metadata: { task_id: "K-5" } });
    const obs2 = observation({ metadata: { cardId: "K-5" } });

    expect(matchObservationToCards(obs, [CARD_K5])[0]).toMatchObject({
      matchedOn: "task-id",
      source: "metadata",
    });
    expect(matchObservationToCards(obs2, [CARD_K5])[0]).toMatchObject({
      matchedOn: "task-id",
      source: "metadata",
    });
  });

  it("matches a branch name mentioned in narrative text", () => {
    const obs = observation({
      narrative: "Continued work on branch kimi/k5-claude-mem today.",
    });

    const matches = matchObservationToCards(obs, [CARD_K5]);

    expect(matches).toContainEqual({
      observationId: 1,
      cardId: "K-5",
      matchedOn: "branch",
      matchedValue: "kimi/k5-claude-mem",
      source: "text",
    });
  });

  it("matches a task id token in the title, case-insensitively", () => {
    const obs = observation({ title: "Finished the k-5 reader package" });

    const matches = matchObservationToCards(obs, [CARD_K5]);

    expect(matches).toContainEqual(
      expect.objectContaining({
        matchedOn: "task-id",
        matchedValue: "K-5",
        source: "text",
      }),
    );
  });

  it("does not match a task id that is a prefix of a longer token", () => {
    const obs = observation({ title: "K-50 follow-up items" });

    expect(matchObservationToCards(obs, [CARD_K5])).toEqual([]);
  });

  it("does not match a task id embedded in the branch string itself", () => {
    const branchless: CardBinding = { cardId: "K-5", identifiers: ["K-5"] };
    const obs = observation({
      narrative: "Switched to kimi/k5-claude-mem and ran tests.",
    });

    expect(matchObservationToCards(obs, [branchless])).toEqual([]);
  });

  it("matches branch names case-sensitively: prose 'Main' is not branch 'main'", () => {
    const card: CardBinding = { cardId: "TB-1", branch: "main" };
    const obs = observation({
      narrative: "Updated the Main page layout copy.",
    });

    expect(matchObservationToCards(obs, [card])).toEqual([]);
  });

  it("dedupes a value repeated across fields", () => {
    const obs = observation({
      title: "kimi/k5-claude-mem",
      narrative: "kimi/k5-claude-mem again",
      facts: ["kimi/k5-claude-mem thrice"],
    });

    const matches = matchObservationToCards(obs, [CARD_K5]);

    expect(
      matches.filter((m) => m.matchedOn === "branch" && m.source === "text"),
    ).toHaveLength(1);
  });

  it("sorts metadata matches before text matches", () => {
    const other: CardBinding = { cardId: "TB-9", branch: "feat/other" };
    const obs = observation({
      metadata: { git_branch: "feat/other" },
      narrative: "Also touched kimi/k5-claude-mem.",
    });

    const matches = matchObservationToCards(obs, [CARD_K5, other]);

    expect(matches[0]).toMatchObject({ source: "metadata", cardId: "TB-9" });
    expect(matches[1]).toMatchObject({ source: "text", cardId: "K-5" });
  });

  it("scans facts, concepts and file lists as text", () => {
    const obs = observation({
      facts: ["See TB-77 for context"],
      filesModified: ["/tmp/synthetic/x.ts"],
    });
    const card: CardBinding = { cardId: "TB-77" };

    const matches = matchObservationToCards(obs, [card]);

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ matchedOn: "task-id", source: "text" });
  });

  it("returns an empty array when nothing matches", () => {
    const obs = observation({ title: "Unrelated work on icons" });

    expect(matchObservationToCards(obs, [CARD_K5])).toEqual([]);
  });

  it("ignores empty identifiers and branches", () => {
    const card: CardBinding = { cardId: "  ", branch: "", identifiers: [""] };
    const obs = observation({ title: "anything" });

    expect(matchObservationToCards(obs, [card])).toEqual([]);
  });
});
