const MAX_LENGTH = 120;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T/;

// One side of a recorded edit, short enough for a history line. Empty values
// come back as null so the caller shows its own dash.
export function formatChangeValue(
  value: unknown,
  formatDate: (iso: string) => string,
): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (Array.isArray(value)) {
    return value.length ? shorten(value.map(String).join(", ")) : null;
  }
  if (typeof value === "string") {
    return ISO_DATE.test(value) ? formatDate(value) : shorten(value);
  }
  if (typeof value === "object") return shorten(JSON.stringify(value));
  return String(value);
}

function shorten(text: string) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_LENGTH ? `${flat.slice(0, MAX_LENGTH)}…` : flat;
}
