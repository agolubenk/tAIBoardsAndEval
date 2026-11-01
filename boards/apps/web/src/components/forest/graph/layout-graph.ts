export type Point = { x: number; y: number };

export type LayoutInput = {
  ids: string[];
  links: { source: string; target: string }[];
  // Nodes of one group (a sector) are pulled together.
  groupOf?: (id: string) => string | null;
  width: number;
  height: number;
  padding?: number;
  iterations?: number;
};

// FNV-1a: the same graph lands the same way on every render and device.
function hash(text: string) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0) / 4294967296;
}

// Force-directed layout (Fruchterman–Reingold) without a library: about 250
// nodes at most, since a larger graph is drawn by groups, so O(n²) per step
// is a few milliseconds.
export function layoutGraph({
  ids,
  links,
  groupOf = () => null,
  width,
  height,
  padding = 24,
  iterations = 80,
}: LayoutInput) {
  const count = ids.length;
  const positions = new Map<string, Point>();
  if (!count) return positions;
  const cx = width / 2;
  const cy = height / 2;
  const points = ids.map((id) => {
    const angle = hash(id) * Math.PI * 2;
    const radius = Math.sqrt(hash(`${id}:r`)) * Math.min(cx, cy);
    return {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
    };
  });
  const index = new Map(ids.map((id, at) => [id, at]));
  const pairs = links.flatMap((link) => {
    const a = index.get(link.source);
    const b = index.get(link.target);
    return a === undefined || b === undefined || a === b ? [] : [[a, b]];
  });
  const groups = ids.map((id) => groupOf(id));
  const k = Math.sqrt((width * height) / count) * 0.75;
  // A pull to the centre that grows with the offset; the repulsion of all
  // nodes balances it near the frame's ellipse. Without it nodes with no
  // links are pushed into the padding and line the border.
  const gravityX = (count * k * k) / (cx - padding) ** 2;
  const gravityY = (count * k * k) / (cy - padding) ** 2;
  let temperature = Math.min(width, height) / 8;

  for (let step = 0; step < iterations; step += 1) {
    const shift = points.map(() => ({ x: 0, y: 0 }));
    for (let a = 0; a < count; a += 1) {
      for (let b = a + 1; b < count; b += 1) {
        const dx = points[a].x - points[b].x;
        const dy = points[a].y - points[b].y;
        const distance = Math.max(Math.hypot(dx, dy), 0.01);
        const push = (k * k) / distance;
        shift[a].x += (dx / distance) * push;
        shift[a].y += (dy / distance) * push;
        shift[b].x -= (dx / distance) * push;
        shift[b].y -= (dy / distance) * push;
      }
    }
    const pull = (a: number, b: number, strength: number) => {
      const dx = points[a].x - points[b].x;
      const dy = points[a].y - points[b].y;
      const distance = Math.max(Math.hypot(dx, dy), 0.01);
      const force = ((distance * distance) / k) * strength;
      shift[a].x -= (dx / distance) * force;
      shift[a].y -= (dy / distance) * force;
      shift[b].x += (dx / distance) * force;
      shift[b].y += (dy / distance) * force;
    };
    for (const [a, b] of pairs) pull(a, b, 1);
    points.forEach((point, at) => {
      shift[at].x -= (point.x - cx) * gravityX;
      shift[at].y -= (point.y - cy) * gravityY;
    });
    const firstOfGroup = new Map<string, number>();
    groups.forEach((group, at) => {
      if (!group) return;
      const first = firstOfGroup.get(group);
      if (first === undefined) firstOfGroup.set(group, at);
      else pull(first, at, 0.5);
    });
    points.forEach((point, at) => {
      const length = Math.max(Math.hypot(shift[at].x, shift[at].y), 0.01);
      const move = Math.min(length, temperature);
      point.x = Math.min(
        width - padding,
        Math.max(padding, point.x + (shift[at].x / length) * move),
      );
      point.y = Math.min(
        height - padding,
        Math.max(padding, point.y + (shift[at].y / length) * move),
      );
    });
    temperature *= 0.95;
  }
  ids.forEach((id, at) => {
    positions.set(id, points[at]);
  });
  return positions;
}
