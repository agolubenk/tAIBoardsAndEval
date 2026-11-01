export const ALL_WORKSPACES = "all";

export function apiKeyWorkspaceMetadata(workspace: string) {
  return workspace === ALL_WORKSPACES ? undefined : { workspaceId: workspace };
}

// The API stores metadata as JSON text and may hand it back still encoded,
// so read both shapes; anything unreadable shows as "one workspace".
export function readApiKeyWorkspace(metadata: unknown): string | null {
  let value = metadata;
  for (let depth = 0; depth < 2 && typeof value === "string"; depth += 1) {
    try {
      value = JSON.parse(value);
    } catch {
      return "";
    }
  }
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return "";
  if (!("workspaceId" in value)) return null;
  const { workspaceId } = value as { workspaceId: unknown };
  return typeof workspaceId === "string" ? workspaceId : "";
}
