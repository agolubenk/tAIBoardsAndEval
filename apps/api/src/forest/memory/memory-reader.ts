import {
  type CachedClaudeMemReader,
  createClaudeMemReader,
  resolveWorkerUrl,
  withCache,
} from "@kaneo/claude-mem-reader";

let reader: CachedClaudeMemReader | undefined;

// One reader per process, so its last-known-good copy outlives a request and
// a card still shows its memory while the Mac with the worker sleeps (R-042).
// Read-only: the worker's GET endpoints, never claude-mem.db (R-040).
export function getMemoryReader(): CachedClaudeMemReader {
  reader ??= withCache(createClaudeMemReader({ baseUrl: resolveWorkerUrl() }));
  return reader;
}

// Optional: limit the scan to one claude-mem project (the repo's name).
export function memoryProject(): string | undefined {
  return process.env.CLAUDE_MEM_PROJECT?.trim() || undefined;
}
