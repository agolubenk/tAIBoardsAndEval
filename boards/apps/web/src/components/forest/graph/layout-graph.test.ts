import { describe, expect, it } from "vite-plus/test";
import { layoutGraph } from "./layout-graph";

const ids = Array.from({ length: 30 }, (_, at) => `n${at}`);
const links = ids
  .slice(1)
  .map((id, at) => ({ source: ids[at] ?? "", target: id }));
const input = { ids, links, width: 640, height: 440, padding: 24 };

describe("layoutGraph", () => {
  it("lands the same way every time, inside the padding", () => {
    const first = layoutGraph(input);
    const second = layoutGraph(input);
    expect([...first]).toEqual([...second]);
    for (const point of first.values()) {
      expect(point.x).toBeGreaterThanOrEqual(24);
      expect(point.x).toBeLessThanOrEqual(616);
      expect(point.y).toBeGreaterThanOrEqual(24);
      expect(point.y).toBeLessThanOrEqual(416);
    }
  });

  it("keeps linked nodes closer than unlinked ones", () => {
    const at = layoutGraph(input);
    const gap = (a: string, b: string) => {
      const p = at.get(a);
      const q = at.get(b);
      return p && q ? Math.hypot(p.x - q.x, p.y - q.y) : Number.NaN;
    };
    const linked = ids.slice(1).map((id, index) => gap(ids[index] ?? "", id));
    const far = gap("n0", "n29");
    const meanLinked =
      linked.reduce((sum, value) => sum + value, 0) / linked.length;
    expect(meanLinked).toBeLessThan(far);
  });

  it("keeps nodes without links off the border", () => {
    const loose = Array.from({ length: 44 }, (_, at) => `l${at}`);
    const at = layoutGraph({ ...input, ids: loose, links: [] });
    const onBorder = [...at.values()].filter(
      (point) =>
        point.x <= 25 || point.x >= 615 || point.y <= 25 || point.y >= 415,
    );
    expect(onBorder.length).toBeLessThanOrEqual(4);
  });

  it("lays out 250 nodes fast enough for a weak phone", () => {
    const many = Array.from({ length: 250 }, (_, at) => `m${at}`);
    const started = performance.now();
    layoutGraph({ ...input, ids: many, links: [] });
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
