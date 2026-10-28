// Every forest read sits under one prefix, so a forest mutation can refresh
// them all at once: the reads are small and the page shows several together.
export const forestKeys = {
  all: (workspaceId: string) => ["forest", workspaceId] as const,
  card: (workspaceId: string, taskId: string) =>
    ["forest", workspaceId, "card", taskId] as const,
};
