/**
 * Техработы: окно, в котором алерты по объекту не поднимаются и не рассылаются (повторы — тоже).
 * Восстановления проходят как обычно. После окна условие, если оно ещё держится, поднимет алерт
 * заново через обычное «N наблюдений подряд» — работы не прячут незакрытую проблему.
 *
 * Объект определяется по маршруту алерта: /infrastructure/<агент> — хост и его контейнеры,
 * /monitoring?monitor=<id> — внешняя проверка; окно на всю консоль (scope=all) глушит всё.
 * Активные окна читаются с кэшем на 10 с: observe() зовётся на каждый отчёт агента.
 */
import { and, desc, gt, isNull, lte } from 'drizzle-orm'
import { getDb } from '../db/client'
import { maintenanceWindows } from '../db/schema'

export type MaintenanceRow = typeof maintenanceWindows.$inferSelect
export type MaintenanceScope = MaintenanceRow['scope']

let cache: { at: number; rows: MaintenanceRow[] } | null = null

export function invalidateMaintenanceCache(): void {
  cache = null
}

export async function activeWindows(now = Date.now()): Promise<MaintenanceRow[]> {
  if (cache && now - cache.at < 10_000) return cache.rows.filter((w) => w.endsAt.getTime() > now && w.startsAt.getTime() <= now)
  const rows = await getDb().query.maintenanceWindows.findMany({
    where: and(gt(maintenanceWindows.endsAt, new Date(now)), lte(maintenanceWindows.startsAt, new Date(now + 3_600_000)), isNull(maintenanceWindows.endedAt)),
    orderBy: desc(maintenanceWindows.endsAt),
    limit: 100,
  })
  cache = { at: now, rows }
  return rows.filter((w) => w.startsAt.getTime() <= now)
}

/** Объект алерта по его маршруту в консоли. */
export function targetOfRoute(route: string | undefined): { scope: 'agent' | 'monitor'; target: string } | null {
  if (!route) return null
  const host = /^\/infrastructure\/([^/?#]+)/.exec(route)
  if (host) return { scope: 'agent', target: decodeURIComponent(host[1]!) }
  const mon = /^\/monitoring\?(?:.*&)?monitor=(\d+)/.exec(route)
  if (mon) return { scope: 'monitor', target: mon[1]! }
  return null
}

export function windowFor(rows: MaintenanceRow[], scope: 'agent' | 'monitor', target: string): MaintenanceRow | null {
  return rows.find((w) => w.scope === 'all' || (w.scope === scope && w.target === target)) ?? null
}

/** Окно техработ, под которое попадает алерт с этим маршрутом (null — работ нет). */
export async function maintenanceForRoute(route: string | undefined, now = Date.now()): Promise<MaintenanceRow | null> {
  const rows = await activeWindows(now)
  if (!rows.length) return null
  const t = targetOfRoute(route)
  if (!t) return rows.find((w) => w.scope === 'all') ?? null
  return windowFor(rows, t.scope, t.target)
}
