// Every notebook read sits under one prefix, so asking a question can refresh
// the thread list and the status (calls today) together.
export const notebookKeys = {
  all: (workspaceId: string) => ["notebook", workspaceId] as const,
  status: (workspaceId: string) => ["notebook", workspaceId, "status"] as const,
  sources: (workspaceId: string) =>
    ["notebook", workspaceId, "sources"] as const,
  threads: (workspaceId: string) =>
    ["notebook", workspaceId, "threads"] as const,
  thread: (workspaceId: string, threadId: string) =>
    ["notebook", workspaceId, "threads", threadId] as const,
  search: (workspaceId: string, query: string) =>
    ["notebook", workspaceId, "search", query] as const,
};
