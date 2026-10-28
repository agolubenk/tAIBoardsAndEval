import { HTTPException } from "hono/http-exception";

export const PAGE_MAX = 100;

export type PageCursor = { at: Date; id: string };

// Keyset cursor over (timestamp desc, id desc): stable while rows are added.
export function encodeCursor({ at, id }: PageCursor) {
  return Buffer.from(`${at.toISOString()}|${id}`).toString("base64url");
}

export function decodeCursor(raw: string | undefined): PageCursor | null {
  if (!raw) return null;
  const [iso, id] = Buffer.from(raw, "base64url").toString().split("|");
  const at = new Date(iso ?? "");
  if (!id || Number.isNaN(at.getTime())) {
    throw new HTTPException(400, { message: "Invalid cursor" });
  }
  return { at, id };
}

export function pageSize(take: number | undefined, fallback = 20) {
  return Math.min(Math.max(take ?? fallback, 1), PAGE_MAX);
}
