/** Доступность мониторов по суточным и часовым агрегатам (check_rollups): обзор, мониторинг, публичная страница, бот. */
import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import { getDb } from '../db/client'
import { checkRollups } from '../db/schema'

const DAY = 86_400_000
const HOUR = 3_600_000

export async function monitorUptime(ids: number[], days = 30): Promise<{
  daily: Map<number, Array<{ day: number; pct: number | null }>>
  last24h: Map<number, { pct: number | null; avgMs: number | null }>
}> {
  const db = getDb()
  const now = Date.now()
  const today = Math.floor(now / DAY) * DAY
  const from = today - (days - 1) * DAY
  const [dailyRows, hourlyRows] = ids.length
    ? await Promise.all([
        db
          .select()
          .from(checkRollups)
          .where(and(inArray(checkRollups.monitorId, ids), eq(checkRollups.grain, 'd'), gte(checkRollups.bucketStart, from))),
        db
          .select({
            monitorId: checkRollups.monitorId,
            total: sql<number>`sum(${checkRollups.total})`,
            ok: sql<number>`sum(${checkRollups.okCount})`,
            latSum: sql<number>`sum(${checkRollups.latencySum})`,
            latN: sql<number>`sum(${checkRollups.latencyCount})`,
          })
          .from(checkRollups)
          .where(
            and(
              inArray(checkRollups.monitorId, ids),
              eq(checkRollups.grain, 'h'),
              gte(checkRollups.bucketStart, Math.floor((now - DAY) / HOUR) * HOUR),
            ),
          )
          .groupBy(checkRollups.monitorId),
      ])
    : [[], []]
  const daily = new Map<number, Array<{ day: number; pct: number | null }>>()
  for (const id of ids) {
    const byDay = new Map(dailyRows.filter((r) => r.monitorId === id).map((r) => [r.bucketStart, r]))
    daily.set(
      id,
      Array.from({ length: days }, (_, i) => {
        const day = from + i * DAY
        const r = byDay.get(day)
        return { day, pct: r && r.total ? Math.round((r.okCount / r.total) * 10000) / 100 : null }
      }),
    )
  }
  const last24h = new Map(
    hourlyRows.map((r) => [
      r.monitorId,
      {
        pct: Number(r.total) ? Math.round((Number(r.ok) / Number(r.total)) * 10000) / 100 : null,
        avgMs: Number(r.latN) ? Math.round(Number(r.latSum) / Number(r.latN)) : null,
      },
    ]),
  )
  return { daily, last24h }
}
