export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** Observation as returned by GET /api/observations (list item). */
export type Observation = {
  id: number;
  memorySessionId: string;
  project: string;
  platformSource: string | null;
  type: string;
  title: string | null;
  subtitle: string | null;
  narrative: string | null;
  text: string | null;
  facts: string[];
  concepts: string[];
  filesRead: string[];
  filesModified: string[];
  promptNumber: number | null;
  createdAt: string;
  createdAtEpoch: number;
};

/** Observation as returned by GET /api/observation/:id (adds metadata). */
export type ObservationDetail = Observation & {
  metadata: Record<string, unknown> | null;
};

/** Response of GET /api/projects. */
export type ProjectsCatalog = {
  projects: string[];
  sources: string[];
  projectsBySource: Record<string, string[]>;
};

/** Response of GET /api/health; the worker adds fields between versions. */
export type WorkerHealth = Record<string, unknown> & { status: string };

/** Page envelope of GET /api/observations. The API has no total count. */
export type Page<T> = {
  items: T[];
  hasMore: boolean;
  offset: number;
  limit: number;
};

/** Epoch milliseconds; injectable so cache tests control time. */
export type Clock = () => number;

export type CacheEntry = {
  value: unknown;
  /** epoch ms when the value was fetched from the worker. */
  fetchedAt: number;
};

export interface CacheStore {
  get(key: string): CacheEntry | undefined;
  set(key: string, entry: CacheEntry): void;
}
