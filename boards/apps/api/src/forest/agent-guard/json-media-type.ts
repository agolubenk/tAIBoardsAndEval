// The guard and kaneo's validator must see the same body. Hono also parses
// application/<x>+json, which a looser check here would read as no changes,
// so an agent's task write must say exactly application/json.
export function isPlainJson(contentType: string | undefined) {
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}
