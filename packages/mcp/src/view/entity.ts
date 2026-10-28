export type Entity = Record<string, unknown> & { id: unknown };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isEntity(value: unknown): value is Entity {
  return isRecord(value) && "id" in value;
}

// A key holding a list of objects is a child collection (column → tasks).
export function isCollection(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.some(isRecord);
}
