/**
 * Статистика проверок за окно: перцентили задержки успешных проверок (отдельно от ошибок — как в
 * прототипе: «latency не смешивается со сбоями»), разбивка ошибок, точки сбоев для меток на
 * графике, средние фазы запроса. Список мониторов читает её с кэшем на минуту.
 */
import { and, avg, count, desc, eq, gte, inArray, isNotNull, max, sql } from 'drizzle-orm'
import { getDb } from '../db/client'
import { checkResults } from '../db/schema'

export interface LatencyStats {
  p50: number | null
  p95: number | null
  p99: number | null
  samples: number
}

/** Перцентиль отсортированного массива (nearest-rank). */
export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!
}

const MAX_ROWS = 50_000
let listCache: { key: string; at: number; data: Map<number, LatencyStats> } | null = null

export async function latencyStats(monitorIds: number[], since: number, opts: { cache?: boolean } = {}): Promise<Map<number, LatencyStats>> {
  const key = `${monitorIds.join(',')}|${Math.floor(since / 60_000)}`
  if (opts.cache && listCache && listCache.key === key && Date.now() - listCache.at < 60_000) return listCache.data
  const out = new Map<number, LatencyStats>()
  if (monitorIds.length) {
    const rows = await getDb()
      .select({ id: checkResults.monitorId, ms: checkResults.latencyMs })
      .from(checkResults)
      .where(and(inArray(checkResults.monitorId, monitorIds), eq(checkResults.ok, true), isNotNull(checkResults.latencyMs), gte(checkResults.createdAt, new Date(since))))
      .limit(MAX_ROWS)
    const by = new Map<number, number[]>()
    for (const r of rows) {
      const list = by.get(r.id) ?? []
      list.push(r.ms ?? 0)
      by.set(r.id, list)
    }
    for (const id of monitorIds) {
      const sorted = (by.get(id) ?? []).sort((a, b) => a - b)
      out.set(id, { p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99), samples: sorted.length })
    }
  }
  if (opts.cache) listCache = { key, at: Date.now(), data: out }
  return out
}

export interface MonitorDetailStats {
  latency: LatencyStats
  errors: Array<{ error: string; count: number; lastAt: number }>
  failures: Array<{ t: number; error: string }>
  phases: { dnsMs: number | null; connectMs: number | null; tlsMs: number | null; ttfbMs: number | null }
}

export async function monitorDetailStats(monitorId: number, since: number): Promise<MonitorDetailStats> {
  const db = getDb()
  const window = and(eq(checkResults.monitorId, monitorId), gte(checkResults.createdAt, new Date(since)))
  const errorKey = sql<string>`coalesce(${checkResults.error}, 'HTTP ' || ${checkResults.statusCode}, 'нет ответа')`
  const [latency, errors, failures, [phases]] = await Promise.all([
    latencyStats([monitorId], since),
    db
      .select({ error: errorKey, count: count(), lastAt: max(checkResults.createdAt) })
      .from(checkResults)
      .where(and(window, eq(checkResults.ok, false)))
      .groupBy(errorKey)
      .orderBy(desc(count()))
      .limit(10),
    db
      .select({ t: checkResults.createdAt, error: errorKey })
      .from(checkResults)
      .where(and(window, eq(checkResults.ok, false)))
      .orderBy(desc(checkResults.createdAt))
      .limit(200),
    db
      .select({ dns: avg(checkResults.dnsMs), connect: avg(checkResults.connectMs), tls: avg(checkResults.tlsMs), ttfb: avg(checkResults.ttfbMs) })
      .from(checkResults)
      .where(and(window, eq(checkResults.ok, true))),
  ])
  const n = (v: string | null | undefined) => (v === null || v === undefined ? null : Math.round(Number(v)))
  return {
    latency: latency.get(monitorId) ?? { p50: null, p95: null, p99: null, samples: 0 },
    errors: errors.map((e) => ({ error: e.error, count: e.count, lastAt: e.lastAt ? new Date(e.lastAt).getTime() : 0 })),
    failures: failures.map((f) => ({ t: f.t.getTime(), error: f.error })),
    phases: { dnsMs: n(phases?.dns), connectMs: n(phases?.connect), tlsMs: n(phases?.tls), ttfbMs: n(phases?.ttfb) },
  }
}
