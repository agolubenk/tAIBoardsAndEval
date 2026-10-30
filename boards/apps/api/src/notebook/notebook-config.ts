// The worker embeds with whatever model the API names; changing the model
// marks every chunk stale and the worker re-embeds the corpus in the
// background, keyword search covering the gap.
export const DEFAULT_EMBED_MODEL = "nomic-embed-text";

// The server default; an administrator can name another one (TB-67).
export function envEmbedModel(): string {
  return process.env.NOTEBOOK_EMBED_MODEL?.trim() || DEFAULT_EMBED_MODEL;
}
