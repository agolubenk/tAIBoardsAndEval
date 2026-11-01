/**
 * «Ресурсы под наблюдением» на главной: только то, что близко к порогу, быстро растёт или
 * заполнится в обозримое время. По каждому хосту — CPU, память, диск (самый заполненный раздел):
 * текущее значение, изменение за окно, порог из правил и для диска/памяти — прогноз заполнения
 * по линейному тренду.
 *
 * История — metric_samples, но не построчно: SQL усредняет по 48 корзинам на окно (7 суток — это
 * ~10 тыс. строк на метрику хоста). Ответ кэшируется на минуту: главная опрашивает каждые 15 с.
 */
import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import { getDb } from '../db/client'
import { agents, alertRules, metricSamples } from '../db/schema'

export const RESOURCE_WINDOWS = { '6h': 6 * 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000 } as const
export type ResourceWindow = keyof typeof RESOURCE_WINDOWS

const METRICS = ['cpu_pct', 'mem_pct', 'disk_pct'] as const
type Metric = (typeof METRICS)[number]
const BUCKETS = 48

export interface WatchedResource {
  agentId: string
  host: string
  metric: Metric
  /** Текущее значение, %. */
  value: number
  /** Изменение за окно, п.п. (последняя корзина минус первая); null — истории мало. */
  delta: number | null
  /** Порог ближайшего включённого правила, %; null — правила нет. */
  threshold: number | null
  /** Через сколько часов при текущем тренде дойдёт до 100% (диск, память); null — не растёт. */
  fullInHours: number | null
  /** Подпись: «188 / 320 ГБ · /data», «10.9 / 16 ГБ · swap 0.1 ГБ». */
  detail: string
  level: 'critical' | 'warning' | 'watch'
  /** Корзины для мини-графика: [начало корзины, среднее]. */
  points: Array<[number, number]>
}

interface Snapshot {
  cpu?: { pct?: number; cores?: number; load1?: number }
  memory?: { totalMb?: number; usedMb?: number; swapTotalMb?: number; swapUsedMb?: number }
  disks?: Array<{ mount: string; totalGb: number; usedGb: number }>
}

const gb = (v: number) => (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10)

/** Наклон линейной регрессии, п.п. в час. */
export function slopePerHour(points: Array<[number, number]>): number | null {
  if (points.length < 4) return null
  const n = points.length
  const xs = points.map(([t]) => t / 3_600_000)
  const ys = points.map(([, v]) => v)
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my)
    den += (xs[i]! - mx) ** 2
  }
  return den ? num / den : null
}

function current(metric: Metric, snap: Snapshot | null): { value: number; detail: string } | null {
  if (!snap) return null
  if (metric === 'cpu_pct') {
    if (typeof snap.cpu?.pct !== 'number') return null
    const parts = [snap.cpu.cores ? `${snap.cpu.cores} vCPU` : '', typeof snap.cpu.load1 === 'number' ? `load ${snap.cpu.load1}` : '']
    return { value: snap.cpu.pct, detail: parts.filter(Boolean).join(' · ') }
  }
  if (metric === 'mem_pct') {
    const m = snap.memory
    if (!m?.totalMb || m.usedMb === undefined) return null
    const swap = m.swapTotalMb ? ` · swap ${gb((m.swapUsedMb ?? 0) / 1024)} ГБ` : ''
    return { value: (m.usedMb / m.totalMb) * 100, detail: `${gb(m.usedMb / 1024)} / ${gb(m.totalMb / 1024)} ГБ${swap}` }
  }
  const disks = (snap.disks ?? []).filter((d) => d.totalGb > 0)
  if (!disks.length) return null
  const worst = disks.reduce((a, d) => (d.usedGb / d.totalGb > a.usedGb / a.totalGb ? d : a))
  return { value: (worst.usedGb / worst.totalGb) * 100, detail: `${gb(worst.usedGb)} / ${gb(worst.totalGb)} ГБ · ${worst.mount}` }
}

function levelOf(r: Pick<WatchedResource, 'value' | 'threshold' | 'delta' | 'fullInHours'>): WatchedResource['level'] | null {
  const limit = r.threshold ?? 90
  if (r.value >= limit) return 'critical'
  if (r.value >= limit - 10 || (r.fullInHours !== null && r.fullInHours <= 7 * 24)) return 'warning'
  if (r.value >= 70 || (r.delta !== null && r.delta >= 10) || (r.fullInHours !== null && r.fullInHours <= 30 * 24)) return 'watch'
  return null
}

const cache = new Map<ResourceWindow, { at: number; data: WatchedResource[] }>()

export function resetResourceCacheForTests(): void {
  cache.clear()
}

export async function watchedResources(window: ResourceWindow, now = Date.now()): Promise<WatchedResource[]> {
  const hit = cache.get(window)
  if (hit && now - hit.at < 60_000) return hit.data
  const db = getDb()
  const span = RESOURCE_WINDOWS[window]
  const from = now - span
  const bucketMs = Math.ceil(span / BUCKETS)
  const hosts = await db.query.agents.findMany({ where: eq(agents.enabled, true), limit: 50 })
  const ids = hosts.map((h) => h.id)
  const [rows, rules] = await Promise.all([
    ids.length
      ? db
          .select({
            agentId: metricSamples.agentId,
            metric: metricSamples.metric,
            bucket: sql<number>`cast(${metricSamples.createdAt} / ${bucketMs} as integer)`,
            avg: sql<number>`avg(${metricSamples.value})`,
          })
          .from(metricSamples)
          .where(and(inArray(metricSamples.agentId, ids), inArray(metricSamples.metric, [...METRICS]), gte(metricSamples.createdAt, new Date(from))))
          .groupBy(metricSamples.agentId, metricSamples.metric, sql`3`)
          .limit(ids.length * METRICS.length * (BUCKETS + 2))
      : Promise.resolve([]),
    db.query.alertRules.findMany({ where: and(eq(alertRules.kind, 'host_metric'), eq(alertRules.enabled, true), eq(alertRules.op, 'gt')), limit: 100 }),
  ])
  const out: WatchedResource[] = []
  for (const host of hosts) {
    const snap = host.lastSnapshotJson ? (JSON.parse(host.lastSnapshotJson) as Snapshot) : null
    for (const metric of METRICS) {
      const cur = current(metric, snap)
      if (!cur) continue
      const points = rows
        .filter((r) => r.agentId === host.id && r.metric === metric)
        .map((r) => [Number(r.bucket) * bucketMs, Number(r.avg)] as [number, number])
        .sort((a, b) => a[0] - b[0])
      const delta = points.length >= 2 ? points.at(-1)![1] - points[0]![1] : null
      const slope = metric === 'cpu_pct' ? null : slopePerHour(points)
      const fullInHours = slope !== null && slope > 0.01 ? Math.max(0, (100 - cur.value) / slope) : null
      const thresholds = rules.filter((r) => r.metric === metric && (!r.agentId || r.agentId === host.id)).map((r) => r.threshold)
      const threshold = thresholds.length ? Math.min(...thresholds) : null
      const base = { value: cur.value, threshold, delta, fullInHours }
      const level = levelOf(base)
      if (!level) continue
      out.push({ agentId: host.id, host: host.name, metric, detail: cur.detail, level, points, ...base })
    }
  }
  const rank = { critical: 0, warning: 1, watch: 2 } as const
  out.sort((a, b) => rank[a.level] - rank[b.level] || b.value - a.value)
  cache.set(window, { at: now, data: out })
  return out
}
