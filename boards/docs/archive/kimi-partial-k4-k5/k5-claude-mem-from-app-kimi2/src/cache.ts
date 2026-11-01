import { ClaudeMemHttpError, type ClaudeMemReader, type ListObservationsParams } from "./client.js";
import type {
  CacheStore,
  Clock,
  Observation,
  ObservationDetail,
  Page,
  ProjectsCatalog,
  WorkerHealth,
} from "./types.js";

export type CachedResult<T> = {
  data: T;
  /** true when the worker was unreachable and data comes from the cache. */
  stale: boolean;
  /** epoch ms when `data` was fetched from the worker (cache write time). */
  fetchedAt: number;
  /** The error that caused the fallback; undefined on a fresh fetch. */
  error?: unknown;
};

export type CachedClaudeMemReader = {
  health(): Promise<CachedResult<WorkerHealth>>;
  listProjects(): Promise<CachedResult<ProjectsCatalog>>;
  listObservations(
    params?: ListObservationsParams,
  ): Promise<CachedResult<Page<Observation>>>;
  getObservation(id: number): Promise<CachedResult<ObservationDetail>>;
};

/** In-memory CacheStore backed by a Map; nothing is persisted to disk. */
export function createMemoryCacheStore(): CacheStore {
  const map = new Map<string, { value: unknown; fetchedAt: number }>();
  return {
    get: (key) => map.get(key),
    set: (key, entry) => {
      map.set(key, entry);
    },
  };
}

function isFallbackEligible(error: unknown): boolean {
  // A 4xx means the worker answered and rejected the request; surfacing it is
  // more useful than serving a stale copy. Network failures, timeouts and 5xx
  // mean the answer may be missing or broken, so a cached copy wins.
  if (error instanceof ClaudeMemHttpError) return error.status >= 500;
  return true;
}

/**
 * Wraps a reader with a last-known-good cache: when the worker is unreachable
 * (Mac asleep), the cached copy is returned with its original `fetchedAt`
 * timestamp and `stale: true` instead of throwing (AC-014). A cache miss
 * rethrows the original error.
 *
 * The default store is in-memory and the default clock is Date.now; both are
 * injectable. In-memory was chosen because the cache is a degraded-mode
 * convenience for one process run — persisting claude-mem content to disk
 * would add staleness and privacy surface for no product requirement.
 */
export function withCache(
  reader: ClaudeMemReader,
  options: { store?: CacheStore; clock?: Clock } = {},
): CachedClaudeMemReader {
  const store = options.store ?? createMemoryCacheStore();
  const clock = options.clock ?? (() => Date.now());

  async function cached<T>(
    key: string,
    call: () => Promise<T>,
  ): Promise<CachedResult<T>> {
    try {
      const data = await call();
      const fetchedAt = clock();
      store.set(key, { value: data, fetchedAt });
      return { data, stale: false, fetchedAt };
    } catch (error) {
      if (isFallbackEligible(error)) {
        const entry = store.get(key);
        if (entry) {
          return {
            data: entry.value as T,
            stale: true,
            fetchedAt: entry.fetchedAt,
            error,
          };
        }
      }
      throw error;
    }
  }

  return {
    health: () => cached("health", () => reader.health()),
    listProjects: () => cached("projects", () => reader.listProjects()),
    listObservations: (params = {}) =>
      cached(`observations:${stableKey(params)}`, () =>
        reader.listObservations(params),
      ),
    getObservation: (id) =>
      cached(`observation:${id}`, () => reader.getObservation(id)),
  };
}

function stableKey(params: ListObservationsParams): string {
  const entries = Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(Object.fromEntries(entries));
}
