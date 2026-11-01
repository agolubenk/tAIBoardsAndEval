import type {
  Observation,
  ObservationDetail,
  Page,
  ProjectsCatalog,
  WorkerHealth,
} from "./types.js";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * facts / concepts / files_read / files_modified travel as JSON-encoded
 * strings in the wire format; tolerate real arrays and garbage too.
 */
export function parseStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string") {
    try {
      return parseStringList(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return [];
}

function parseMetadata(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      return parseMetadata(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return null;
}

export function parseObservation(value: unknown): Observation {
  const raw = asRecord(value);
  return {
    id: asNumber(raw.id) ?? 0,
    memorySessionId: asString(raw.memory_session_id) ?? "",
    project: asString(raw.project) ?? "",
    platformSource: asString(raw.platform_source),
    type: asString(raw.type) ?? "unknown",
    title: asString(raw.title),
    subtitle: asString(raw.subtitle),
    narrative: asString(raw.narrative),
    text: asString(raw.text),
    facts: parseStringList(raw.facts),
    concepts: parseStringList(raw.concepts),
    filesRead: parseStringList(raw.files_read),
    filesModified: parseStringList(raw.files_modified),
    promptNumber: asNumber(raw.prompt_number),
    createdAt: asString(raw.created_at) ?? "",
    createdAtEpoch: asNumber(raw.created_at_epoch) ?? 0,
  };
}

export function parseObservationDetail(value: unknown): ObservationDetail {
  const raw = asRecord(value);
  return { ...parseObservation(raw), metadata: parseMetadata(raw.metadata) };
}

export function parsePage<T>(
  value: unknown,
  parseItem: (item: unknown) => T,
): Page<T> {
  const raw = asRecord(value);
  const items = Array.isArray(raw.items) ? raw.items.map(parseItem) : [];
  return {
    items,
    hasMore: raw.hasMore === true,
    offset: asNumber(raw.offset) ?? 0,
    limit: asNumber(raw.limit) ?? items.length,
  };
}

export function parseProjectsCatalog(value: unknown): ProjectsCatalog {
  const raw = asRecord(value);
  const projectsBySource: Record<string, string[]> = {};
  for (const [source, projects] of Object.entries(asRecord(raw.projectsBySource))) {
    projectsBySource[source] = parseStringList(projects);
  }
  return {
    projects: parseStringList(raw.projects),
    sources: parseStringList(raw.sources),
    projectsBySource,
  };
}

export function parseHealth(value: unknown): WorkerHealth {
  const raw = asRecord(value);
  return { ...raw, status: asString(raw.status) ?? "unknown" };
}
