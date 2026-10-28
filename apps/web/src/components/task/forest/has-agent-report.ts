import type { CardMeta } from "./card-types";

export function hasAgentReport(meta: CardMeta) {
  return Boolean(
    meta.executor ||
    meta.branch ||
    meta.pullRequests.length ||
    meta.files.length ||
    meta.tokens !== null ||
    meta.costUsd !== null ||
    meta.contextPack,
  );
}
