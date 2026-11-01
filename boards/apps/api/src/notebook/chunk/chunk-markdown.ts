export type MarkdownChunk = { heading: string; text: string };

export const CHUNK_MAX_CHARS = 1600;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

type Section = { heading: string; lines: string[] };

// Headings give each chunk its place ("Spec › Data › Tables"), so a hit reads
// on its own; a heading inside a code fence is code, not structure.
function sections(markdown: string): Section[] {
  const path: string[] = [];
  const out: Section[] = [{ heading: "", lines: [] }];
  let fenced = false;
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    const match = fenced ? null : HEADING.exec(line);
    if (match?.[1] && match[2]) {
      path.length = match[1].length - 1;
      path[match[1].length - 1] = match[2];
      out.push({ heading: path.filter(Boolean).join(" › "), lines: [] });
      continue;
    }
    out[out.length - 1]?.lines.push(line);
  }
  return out;
}

// Blank lines split paragraphs except inside a fence, so code stays whole
// unless it alone is longer than a chunk.
function paragraphs(lines: string[]): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let fenced = false;
  for (const line of lines) {
    if (FENCE.test(line)) fenced = !fenced;
    if (!fenced && line.trim() === "") {
      if (current.length) out.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length) out.push(current.join("\n"));
  return out;
}

function hardSplit(text: string, max: number): string[] {
  const out: string[] = [];
  for (let start = 0; start < text.length; start += max) {
    out.push(text.slice(start, start + max));
  }
  return out;
}

export function chunkMarkdown(
  markdown: string,
  max = CHUNK_MAX_CHARS,
): MarkdownChunk[] {
  const chunks: MarkdownChunk[] = [];
  for (const { heading, lines } of sections(markdown)) {
    let current = "";
    const flush = () => {
      if (current.trim()) chunks.push({ heading, text: current.trim() });
      current = "";
    };
    for (const paragraph of paragraphs(lines)) {
      const pieces =
        paragraph.length > max ? hardSplit(paragraph, max) : [paragraph];
      for (const piece of pieces) {
        if (current && current.length + piece.length + 2 > max) flush();
        current = current ? `${current}\n\n${piece}` : piece;
      }
    }
    flush();
  }
  return chunks;
}
