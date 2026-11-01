export type ToolDoc = { name: string; description: string };

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "the",
  "this",
  "to",
  "with",
]);

// "entries" and "entry" must meet, so plurals fold to one form.
function stem(word: string) {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss"))
    return word.slice(0, -1);
  return word;
}

function terms(text: string) {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
    .map(stem);
}

// The name says what a tool does more plainly than its description, so its
// words count twice.
function docTerms(doc: ToolDoc) {
  const name = terms(doc.name.replaceAll("_", " "));
  return [...name, ...name, ...terms(doc.description)];
}

function counts(words: string[]) {
  const tf = new Map<string, number>();
  for (const word of words) tf.set(word, (tf.get(word) ?? 0) + 1);
  return tf;
}

function weigh(tf: Map<string, number>, idf: Map<string, number>) {
  const vector = new Map<string, number>();
  for (const [word, n] of tf) {
    const weight = idf.get(word);
    if (weight) vector.set(word, n * weight);
  }
  return vector;
}

function norm(vector: Map<string, number>) {
  let sum = 0;
  for (const value of vector.values()) sum += value * value;
  return Math.sqrt(sum);
}

function cosine(a: Map<string, number>, b: Map<string, number>) {
  const length = norm(a) * norm(b);
  if (length === 0) return 0;
  let dot = 0;
  for (const [word, value] of a) dot += value * (b.get(word) ?? 0);
  return dot / length;
}

// A hit under half the best one shares a word by chance ("log" in
// forest_get_log for "log a time entry") and must not take a slot.
const NEAR_SHARE = 0.5;

// R-034: the tools nearest to a request, by TF-IDF vectors over each tool's
// name and description. Exact ties keep name order, so the answer is stable.
export function rankTools(query: string, docs: ToolDoc[], limit: number) {
  const docCounts = docs.map((doc) => counts(docTerms(doc)));
  const df = new Map<string, number>();
  for (const tf of docCounts)
    for (const word of tf.keys()) df.set(word, (df.get(word) ?? 0) + 1);
  const idf = new Map<string, number>();
  for (const [word, n] of df)
    idf.set(word, Math.log((docs.length + 1) / (n + 1)) + 1);

  const asked = weigh(counts(terms(query)), idf);
  const hits = docs
    .map((doc, i) => ({
      name: doc.name,
      score: cosine(asked, weigh(docCounts[i] ?? new Map(), idf)),
    }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const floor = (hits[0]?.score ?? 0) * NEAR_SHARE;
  return hits
    .filter((hit) => hit.score >= floor)
    .slice(0, limit)
    .map((hit) => hit.name);
}
