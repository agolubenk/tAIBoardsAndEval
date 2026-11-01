/**
 * Плитки главной (как в прототипе): сервисы, серверы, контейнеры, ресурсы у порога, домены и TLS,
 * доставка уведомлений — по каждой число и короткая причина. Считается из того, что главная уже
 * читает, плюс три лёгких запроса (TLS, каналы, подписки Telegram).
 */
import { and, eq, isNotNull } from 'drizzle-orm'
import { getDb } from '../db/client'
import { channels, tgSubscriptions } from '../db/schema'
import { isContainerDown } from '../alerts/container-state'

export interface OverviewKpis {
  /** stopped — упавшие (не считая штатно завершённых разовых задач). */
  containers: { total: number; running: number; restarting: number; unhealthy: number; stopped: number }
  tls: { total: number; atRisk: number; nearest: { domain: string; daysLeft: number | null; error: string | null } | null }
  notifications: {
    channels: number
    failing: Array<{ name: string; error: string; at: number | null }>
    lastOkAt: number | null
    subscriptions: number
    subscriptionsFailing: number
  }
}

/** TLS «под риском» — меньше стольких дней или ошибка проверки (порог встроенного правила). */
export const TLS_RISK_DAYS = 21

type ContainerLite = { state: string; health: string; restartPolicy: string; exitCode: number | null }

export async function overviewKpis(containerRows: ContainerLite[]): Promise<OverviewKpis> {
  const db = getDb()
  const [tls, chans, subs] = await Promise.all([
    db.query.tlsChecks.findMany({ limit: 100 }),
    db.query.channels.findMany({ where: eq(channels.enabled, true), limit: 50 }),
    db
      .select({ lastError: tgSubscriptions.lastError })
      .from(tgSubscriptions)
      .where(and(eq(tgSubscriptions.state, 'active'), isNotNull(tgSubscriptions.activatedAt)))
      .limit(200),
  ])
  const risky = tls
    .filter((t) => t.error || (t.daysLeft !== null && t.daysLeft < TLS_RISK_DAYS))
    .sort((a, b) => (a.error ? -1 : b.error ? 1 : (a.daysLeft ?? 0) - (b.daysLeft ?? 0)))
  const nearest = risky[0] ?? [...tls].sort((a, b) => (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999))[0] ?? null
  const failing = chans.filter((c) => c.lastErrorAt && (!c.lastOkAt || c.lastErrorAt > c.lastOkAt))
  const lastOk = chans.reduce<number | null>((acc, c) => (c.lastOkAt ? Math.max(acc ?? 0, c.lastOkAt.getTime()) : acc), null)
  return {
    containers: {
      total: containerRows.length,
      running: containerRows.filter((c) => c.state === 'running').length,
      restarting: containerRows.filter((c) => c.state === 'restarting').length,
      unhealthy: containerRows.filter((c) => c.health === 'unhealthy').length,
      stopped: containerRows.filter((c) => c.state !== 'restarting' && isContainerDown(c)).length,
    },
    tls: {
      total: tls.length,
      atRisk: risky.length,
      nearest: nearest ? { domain: nearest.domain, daysLeft: nearest.daysLeft, error: nearest.error } : null,
    },
    notifications: {
      channels: chans.length,
      failing: failing.map((c) => ({ name: c.name, error: (c.lastError ?? '').slice(0, 160), at: c.lastErrorAt?.getTime() ?? null })),
      lastOkAt: lastOk,
      subscriptions: subs.length,
      subscriptionsFailing: subs.filter((s) => s.lastError).length,
    },
  }
}
