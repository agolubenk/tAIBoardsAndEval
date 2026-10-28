// Throughput and p95 latency of redact() on a 1 MiB chunk. Run: pnpm bench
import { performance } from "node:perf_hooks";
import { redact } from "./src/index.ts";

const KiB = 1024;
const chunkSize = KiB * KiB;

// Realistic-ish transcript filler: prose with embedded non-secret tokens
// (git SHAs, UUIDs, hashes) so the benchmark includes the reject paths.
function fillerLine(i: number): string {
  const sha = (i * 2654435761).toString(16).padStart(40, "a").slice(0, 40);
  const hex = (i * 40503).toString(16).padStart(64, "b").slice(0, 64);
  return `line ${i}: commit ${sha} digest ${hex} some ordinary prose about tasks and boards\n`;
}

let text = "";
let i = 0;
while (text.length < chunkSize) {
  text += fillerLine(i);
  i += 1;
}
text = text.slice(0, chunkSize);

const iterations = 60;
const durations: number[] = [];

// warmup
for (let w = 0; w < 5; w += 1) redact(text);

for (let n = 0; n < iterations; n += 1) {
  const start = performance.now();
  redact(text);
  durations.push(performance.now() - start);
}

durations.sort((a, b) => a - b);
const p95 = durations[Math.floor(durations.length * 0.95)];
const totalSeconds = durations.reduce((sum, d) => sum + d, 0) / 1000;
const throughput = (chunkSize * iterations) / totalSeconds / (KiB * KiB);

console.log(`chunk: ${chunkSize} bytes, iterations: ${iterations}`);
console.log(`throughput: ${throughput.toFixed(1)} MiB/s`);
console.log(`p95 latency: ${p95?.toFixed(2)} ms`);
