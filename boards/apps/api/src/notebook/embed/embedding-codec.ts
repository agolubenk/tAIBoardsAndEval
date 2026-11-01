// Embeddings travel as base64 of float32 little-endian and rest as the same
// bytes in bytea: 3 KB per 768-dim vector instead of ~10 KB of JSON numbers.
export const EMBEDDING_MAX_DIMS = 4096;

export function encodeEmbedding(vector: ArrayLike<number>): Buffer {
  const buffer = Buffer.alloc(vector.length * 4);
  for (let i = 0; i < vector.length; i++) {
    buffer.writeFloatLE(vector[i] ?? 0, i * 4);
  }
  return buffer;
}

export function decodeEmbedding(bytes: Buffer): Float32Array {
  const vector = new Float32Array(bytes.length / 4);
  for (let i = 0; i < vector.length; i++) vector[i] = bytes.readFloatLE(i * 4);
  return vector;
}

// Null for anything that is not a finite float32 vector of a sane size.
export function parseEmbedding(base64: string): Buffer | null {
  const bytes = Buffer.from(base64, "base64");
  const dims = bytes.length / 4;
  if (!Number.isInteger(dims) || dims < 1 || dims > EMBEDDING_MAX_DIMS) {
    return null;
  }
  for (const value of decodeEmbedding(bytes)) {
    if (!Number.isFinite(value)) return null;
  }
  return bytes;
}

export function normalize(vector: Float32Array): Float32Array {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm === 0) return vector;
  return vector.map((value) => value / norm);
}

// Both sides normalized: the dot product is the cosine.
export function dot(a: Float32Array, b: Float32Array, offset = 0): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] ?? 0) * (b[offset + i] ?? 0);
  return sum;
}
