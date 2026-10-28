import type getNotebookStatus from "@/fetchers/notebook/get-notebook-status";
import type getNotebookThread from "@/fetchers/notebook/get-notebook-thread";
import type listNotebookSources from "@/fetchers/notebook/list-notebook-sources";
import type listNotebookThreads from "@/fetchers/notebook/list-notebook-threads";
import type searchNotebook from "@/fetchers/notebook/search-notebook";

export type NotebookStatus = Awaited<ReturnType<typeof getNotebookStatus>>;
export type NotebookSource = Awaited<
  ReturnType<typeof listNotebookSources>
>["sources"][number];
export type NotebookSearch = Awaited<ReturnType<typeof searchNotebook>>;
export type NotebookSearchResult = NotebookSearch["results"][number];
export type NotebookThreadSummary = Awaited<
  ReturnType<typeof listNotebookThreads>
>["threads"][number];
export type NotebookMessage = Awaited<
  ReturnType<typeof getNotebookThread>
>["messages"][number];
export type NotebookCitation = NotebookMessage["citations"][number];
export type NotebookSourceKind = NotebookSource["kind"];

export const NOTEBOOK_TABS = ["chat", "search", "sources"] as const;
export type NotebookTab = (typeof NOTEBOOK_TABS)[number];

export function isNotebookTab(value: unknown): value is NotebookTab {
  return (NOTEBOOK_TABS as readonly unknown[]).includes(value);
}
