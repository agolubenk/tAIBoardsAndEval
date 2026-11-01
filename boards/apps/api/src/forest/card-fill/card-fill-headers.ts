import type { Context } from "hono";

// What an agent says about a status change, sent beside the upstream body.
// Header values are Latin-1, so the note travels percent-encoded.
export const NOTE_HEADER = "x-t-boards-note";
export const LINK_HEADER = "x-t-boards-link";

const MAX_NOTE = 2000;
const MAX_LINK = 500;

export type CardFillHeaders = { note: string | null; link: string | null };

// Control characters other than line breaks and tabs are dropped.
function isPrintable(char: string) {
  const code = char.codePointAt(0) ?? 0;
  return (code >= 0x20 && code !== 0x7f) || "\t\n\r".includes(char);
}

export function parseNote(raw: string | undefined): string | null {
  if (!raw) return null;
  let text: string;
  try {
    text = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const clean = Array.from(text).filter(isPrintable).join("").trim();
  return clean && clean.length <= MAX_NOTE ? clean : null;
}

export function parseLink(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value || value.length > MAX_LINK) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function readCardFillHeaders(c: Context): CardFillHeaders {
  return {
    note: parseNote(c.req.header(NOTE_HEADER)),
    link: parseLink(c.req.header(LINK_HEADER)),
  };
}
