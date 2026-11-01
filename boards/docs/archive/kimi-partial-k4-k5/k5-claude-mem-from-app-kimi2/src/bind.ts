import type { Observation } from "./types.js";

/** Observation fields the matcher reads; metadata exists only on detail. */
export type ObservationLike = Observation & {
  metadata?: Record<string, unknown> | null;
};

export type CardBinding = {
  /** t-boards card id; matched as a token in observation text/metadata. */
  cardId: string;
  /** Git branch associated with the card, e.g. "kimi/k5-claude-mem". */
  branch?: string | null;
  /** Extra task identifiers shown in prose, e.g. "K-5", "TB-1042". */
  identifiers?: string[];
};

export type MatchSource = "metadata" | "text";
export type MatchedOn = "branch" | "task-id";

export type ObservationCardMatch = {
  observationId: number;
  cardId: string;
  matchedOn: MatchedOn;
  /** The branch or identifier that matched (as written on the card). */
  matchedValue: string;
  source: MatchSource;
};

const MATCH_RANK: Record<`${MatchSource}:${MatchedOn}`, number> = {
  "metadata:task-id": 0,
  "metadata:branch": 1,
  "text:task-id": 2,
  "text:branch": 3,
};

// Characters that may not surround a token: anything that would make the
// token part of a longer identifier, word or path.
const BOUNDARY = "A-Za-z0-9_/\\-";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsToken(
  haystack: string,
  token: string,
  { caseSensitive }: { caseSensitive: boolean },
): boolean {
  if (token.trim() === "") return false;
  const pattern = new RegExp(
    `(?<![${BOUNDARY}])${escapeRegExp(token)}(?![${BOUNDARY}])`,
    caseSensitive ? "u" : "iu",
  );
  return pattern.test(haystack);
}

function collectMetadataValues(
  metadata: Record<string, unknown>,
  keyPattern: RegExp,
): string[] {
  const values: string[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (keyPattern.test(key) && typeof value === "string") {
      values.push(value);
    }
  }
  return values;
}

function textHaystack(observation: ObservationLike): string {
  return [
    observation.title,
    observation.subtitle,
    observation.narrative,
    observation.text,
    ...observation.facts,
    ...observation.concepts,
    ...observation.filesRead,
    ...observation.filesModified,
  ]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
}

/**
 * Pure binding of an observation to t-boards cards (R-042). Two signals:
 * the git branch name and task identifiers, looked up in observation
 * metadata (exact match) and in the observation text (token match with
 * identifier boundaries, so "K-5" does not match "K-50" or the inside of
 * "kimi/k5-claude-mem").
 *
 * Case: identifiers match case-insensitively ("k-5" ~ "K-5"); branch names
 * match case-sensitively because git branches are case-sensitive and prose
 * words like "Main" must not bind to a branch "main".
 *
 * Result is sorted by signal strength: metadata before text, task-id before
 * branch; ties break by cardId for determinism.
 */
export function matchObservationToCards(
  observation: ObservationLike,
  cards: CardBinding[],
): ObservationCardMatch[] {
  const matches: ObservationCardMatch[] = [];
  const seen = new Set<string>();
  const push = (match: ObservationCardMatch) => {
    const key = [
      match.cardId,
      match.matchedOn,
      match.matchedValue,
      match.source,
    ].join("|");
    if (!seen.has(key)) {
      seen.add(key);
      matches.push(match);
    }
  };

  const metadata = observation.metadata ?? null;
  const metadataBranches = metadata
    ? collectMetadataValues(metadata, /branch/i)
    : [];
  const metadataIds = metadata
    ? collectMetadataValues(metadata, /(task|card|issue)[_-]?id/i)
    : [];
  const haystack = textHaystack(observation);

  for (const card of cards) {
    if (card.branch) {
      const branch = card.branch;
      if (metadataBranches.some((value) => value === branch)) {
        push({
          observationId: observation.id,
          cardId: card.cardId,
          matchedOn: "branch",
          matchedValue: branch,
          source: "metadata",
        });
      } else if (containsToken(haystack, branch, { caseSensitive: true })) {
        push({
          observationId: observation.id,
          cardId: card.cardId,
          matchedOn: "branch",
          matchedValue: branch,
          source: "text",
        });
      }
    }

    const identifiers = [card.cardId, ...(card.identifiers ?? [])];
    for (const identifier of identifiers) {
      if (identifier.trim() === "") continue;
      if (
        metadataIds.some(
          (value) => value.toLowerCase() === identifier.toLowerCase(),
        )
      ) {
        push({
          observationId: observation.id,
          cardId: card.cardId,
          matchedOn: "task-id",
          matchedValue: identifier,
          source: "metadata",
        });
      } else if (containsToken(haystack, identifier, { caseSensitive: false })) {
        push({
          observationId: observation.id,
          cardId: card.cardId,
          matchedOn: "task-id",
          matchedValue: identifier,
          source: "text",
        });
      }
    }
  }

  return matches.sort(
    (a, b) =>
      MATCH_RANK[`${a.source}:${a.matchedOn}`] -
        MATCH_RANK[`${b.source}:${b.matchedOn}`] || a.cardId.localeCompare(b.cardId),
  );
}
