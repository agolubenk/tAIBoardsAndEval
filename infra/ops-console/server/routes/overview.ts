/** Главная консоли: что горит, состояние сервисов за 30 дней, хосты, последние изменения. */
import { Hono } from 'hono'
import { desc, eq, inArray, sql } from 'drizzle-orm'
import { getDb } from '../db/client'
import { activity, agents, alerts, commands, containers, deploys, incidents, monitors } from '../db/schema'
import type { AppEnv } from '../http-types'
import { requireRole } from '../auth/middleware'
import { runTick } from '../scheduler/tick'
import { getGeneralSettings } from '../settings/store'
import { agentUiStatus } from './status'
import { monitorUptime } from '../monitors/uptime'
import { serializeAlert, serializeMonitor } from './serialize'
import { overviewKpis } from '../overview/kpis'
import { onboardingSteps } from '../overview/onboarding'
import { activeWindows, windowFor } from '../maintenance/store'
import { maintenanceView } from './maintenance'
import { watchedResources } from '../overview/resources'
import { listSnapshot } from '../agents/vpn'
import { parseQuery } from '../lib/validate'
import { z } from 'zod'

/** Для существующих импортов: расчёт живёт в monitors/uptime.ts. */
export { monitorUptime }

export const overviewRoutes = new Hono<AppEnv>()
  .get('/counts', async (c) => {
    const db = getDb()
    const [bySeverity, open] = await Promise.all([
      db
        .select({ severity: alerts.severity, n: sql<number>`count(*)` })
        .from(alerts)
        .where(eq(alerts.status, 'firing'))
        .groupBy(alerts.severity),
      db
        .select({ n: sql<number>`count(*)` })
        .from(incidents)
        .where(inArray(incidents.status, ['active', 'monitoring'])),
    ])
    const sev = Object.fromEntries(bySeverity.map((r) => [r.severity, Number(r.n)]))
    return c.json({ critical: sev.critical ?? 0, warning: sev.warning ?? 0, incidents: Number(open[0]?.n ?? 0) })
  })
  .post('/tick', requireRole('operator'), async (c) => c.json(await runTick()))
  .get('/', async (c) => {
    const db = getDb()
    const general = await getGeneralSettings()
    const [monitorRows, agentRows, firing, openIncidents, recentActivity, recentDeploys, recentCommands, containerRows] = await Promise.all(
      [
        db.query.monitors.findMany({ orderBy: [monitors.sortOrder, monitors.id], limit: 100 }),
        db.query.agents.findMany({ orderBy: agents.name, limit: 50 }),
        db.query.alerts.findMany({ where: eq(alerts.status, 'firing'), orderBy: desc(alerts.startedAt), limit: 100 }),
        db.query.incidents.findMany({
          where: inArray(incidents.status, ['active', 'monitoring']),
          orderBy: desc(incidents.startedAt),
          limit: 20,
        }),
        db.query.activity.findMany({ orderBy: desc(activity.createdAt), limit: 12 }),
        db.query.deploys.findMany({ orderBy: desc(deploys.createdAt), limit: 5 }),
        db.query.commands.findMany({ orderBy: desc(commands.requestedAt), limit: 5 }),
        db
          .select({
            agentId: containers.agentId,
            state: containers.state,
            health: containers.health,
            restartPolicy: containers.restartPolicy,
            exitCode: containers.exitCode,
          })
          .from(containers)
          .limit(2000),
      ],
    )
    const [uptime, kpis, windows] = await Promise.all([monitorUptime(monitorRows.map((m) => m.id)), overviewKpis(containerRows), activeWindows()])
    const firingLite = firing.map((a) => ({ severity: a.severity, route: a.route }))
    return c.json({
      consoleName: general.consoleName,
      alerts: firing.map(serializeAlert),
      incidents: openIncidents.map((i) => ({ ...i, startedAt: i.startedAt.getTime(), resolvedAt: i.resolvedAt?.getTime() ?? null })),
      monitors: monitorRows.map((m) => ({
        ...serializeMonitor(m),
        maintenance: maintenanceView(windowFor(windows, 'monitor', String(m.id))),
        uptime30d: uptime.daily.get(m.id) ?? [],
        uptime24h: uptime.last24h.get(m.id)?.pct ?? null,
        avgLatency24h: uptime.last24h.get(m.id)?.avgMs ?? null,
      })),
      agents: agentRows.map((a) => {
        const own = containerRows.filter((ctr) => ctr.agentId === a.id)
        return {
          id: a.id,
          name: a.name,
          environment: a.environment,
          status: agentUiStatus(a, firingLite, general.agentSilentAfterIntervals, Date.now(), Boolean(windowFor(windows, 'agent', a.id))),
          lastSeenAt: a.lastSeenAt?.getTime() ?? null,
          snapshot: listSnapshot(a.lastSnapshotJson),
          containers: {
            total: own.length,
            running: own.filter((x) => x.state === 'running').length,
            unhealthy: own.filter((x) => x.health === 'unhealthy').length,
          },
        }
      }),
      activity: recentActivity.map((e) => ({ ...e, createdAt: e.createdAt.getTime() })),
      deploys: recentDeploys.map((d) => ({
        ...d,
        startedAt: d.startedAt?.getTime() ?? null,
        finishedAt: d.finishedAt?.getTime() ?? null,
        createdAt: d.createdAt.getTime(),
      })),
      commands: recentCommands.map((x) => ({
        ...x,
        requestedAt: x.requestedAt.getTime(),
        claimedAt: x.claimedAt?.getTime() ?? null,
        finishedAt: x.finishedAt?.getTime() ?? null,
      })),
      kpis,
      maintenance: windows.map((w) => maintenanceView(w)),
      serverTime: Date.now(),
    })
  })
  .get('/onboarding', async (c) => c.json({ steps: await onboardingSteps() }))
  .get('/resources', async (c) => {
    const { window } = parseQuery(c, z.object({ window: z.enum(['6h', '24h', '7d']).default('6h') }))
    return c.json({ window, resources: await watchedResources(window) })
  })
