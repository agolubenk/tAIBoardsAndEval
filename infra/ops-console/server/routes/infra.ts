/** Инфраструктура: хосты (агенты), контейнеры, метрики, перезапуски. */
import { Hono } from 'hono'
import { and, asc, desc, eq, gte } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/client'
import { agentDomains, agents, agentVpn, alerts, commands, containers, metricSamples } from '../db/schema'
import { apiError, type AppEnv } from '../http-types'
import { requireRole } from '../auth/middleware'
import { parseBody, parseQuery } from '../lib/validate'
import { requestRestart, RESTART_MIN_ROLE } from '../containers/restart'
import { getGeneralSettings } from '../settings/store'
import { getEnv } from '../env'
import { agentUiStatus } from './status'
import { recentRestarts } from '../agents/restarts'
import { activeWindows, windowFor } from '../maintenance/store'
import { maintenanceView } from './maintenance'
import { serializeAlert } from './serialize'
import { daysLeft } from '../agents/domains'
import { listSnapshot } from '../agents/vpn'

const ms = (d: Date | null | undefined) => (d ? d.getTime() : null)

const seriesQuery = z.object({
  metric: z.string().regex(/^[A-Za-z0-9_:.-]{1,64}$/),
  hours: z.coerce.number().int().min(1).max(720).default(6),
})

/** Только форма тела: правила (роль, причина, имя, очередь, пауза) — в requestRestart, общем с ботом. */
const restartBody = z.object({
  reason: z.string().default(''),
  confirmName: z.string().max(190).optional(),
})

/** Не больше ~360 точек на график: равномерная выборка, а не первые N строк. */
function downsample<T>(rows: T[], max = 360): T[] {
  if (rows.length <= max) return rows
  const step = rows.length / max
  return Array.from({ length: max }, (_, i) => rows[Math.floor(i * step)] as T)
}

function serializeContainer(ctr: typeof containers.$inferSelect) {
  return { ...ctr, startedAt: ms(ctr.startedAt), updatedAt: ctr.updatedAt.getTime() }
}

export const infraRoutes = new Hono<AppEnv>()
  .get('/agents', async (c) => {
    const db = getDb()
    const general = await getGeneralSettings()
    const [rows, ctrs, firing, windows] = await Promise.all([
      db.query.agents.findMany({ orderBy: agents.name, limit: 50 }),
      db.query.containers.findMany({ orderBy: [containers.agentId, containers.name], limit: 2000 }),
      db.select({ severity: alerts.severity, route: alerts.route }).from(alerts).where(eq(alerts.status, 'firing')).limit(500),
      activeWindows(),
    ])
    return c.json({
      agents: rows.map((a) => ({
        id: a.id,
        name: a.name,
        environment: a.environment,
        enabled: a.enabled,
        status: agentUiStatus(a, firing, general.agentSilentAfterIntervals, Date.now(), Boolean(windowFor(windows, 'agent', a.id))),
        maintenance: maintenanceView(windowFor(windows, 'agent', a.id)),
        lastSeenAt: ms(a.lastSeenAt),
        reportIntervalSec: a.reportIntervalSec,
        snapshot: listSnapshot(a.lastSnapshotJson),
      })),
      containers: ctrs.map(serializeContainer),
    })
  })
  .get('/agents/:id', async (c) => {
    const db = getDb()
    const id = c.req.param('id')
    const agent = await db.query.agents.findFirst({ where: eq(agents.id, id) })
    if (!agent) throw apiError(404, 'Агент не найден')
    const general = await getGeneralSettings()
    const route = `/infrastructure/${encodeURIComponent(id)}`
    const [ctrs, firing, cmds, windows] = await Promise.all([
      db.query.containers.findMany({ where: eq(containers.agentId, id), orderBy: containers.name, limit: 250 }),
      db.query.alerts.findMany({
        where: and(eq(alerts.status, 'firing'), eq(alerts.route, route)),
        orderBy: desc(alerts.startedAt),
        limit: 50,
      }),
      db.query.commands.findMany({ where: eq(commands.agentId, id), orderBy: desc(commands.requestedAt), limit: 20 }),
      activeWindows(),
    ])
    const win = windowFor(windows, 'agent', agent.id)
    const restarts10m = await recentRestarts(agent.id, ctrs)
    return c.json({
      restarts10m,
      agent: {
        id: agent.id,
        name: agent.name,
        environment: agent.environment,
        enabled: agent.enabled,
        status: agentUiStatus(agent, firing, general.agentSilentAfterIntervals, Date.now(), Boolean(win)),
        maintenance: maintenanceView(win),
        lastSeenAt: ms(agent.lastSeenAt),
        reportIntervalSec: agent.reportIntervalSec,
        snapshot: agent.lastSnapshotJson ? (JSON.parse(agent.lastSnapshotJson) as Record<string, unknown>) : null,
      },
      containers: ctrs.map(serializeContainer),
      alerts: firing.map(serializeAlert),
      commands: cmds.map((x) => ({ ...x, requestedAt: x.requestedAt.getTime(), claimedAt: ms(x.claimedAt), finishedAt: ms(x.finishedAt) })),
      restartCooldownSec: general.restartCooldownSec,
    })
  })
  .get('/agents/:id/series', async (c) => {
    const { metric, hours } = parseQuery(c, seriesQuery)
    const rows = await getDb()
      .select({ t: metricSamples.createdAt, v: metricSamples.value })
      .from(metricSamples)
      .where(
        and(
          eq(metricSamples.agentId, c.req.param('id')),
          eq(metricSamples.metric, metric),
          gte(metricSamples.createdAt, new Date(Date.now() - hours * 3_600_000)),
        ),
      )
      .orderBy(asc(metricSamples.createdAt))
      .limit(50_000)
    return c.json({ metric, hours, points: downsample(rows).map((r) => [r.t.getTime(), r.v]) })
  })
  .post('/agents/:id/containers/:name/restart', requireRole(RESTART_MIN_ROLE), async (c) => {
    const body = await parseBody(c, restartBody)
    const { commandId } = await requestRestart(c.get('user'), {
      agentId: c.req.param('id'),
      container: c.req.param('name'),
      reason: body.reason,
      confirmName: body.confirmName,
    })
    return c.json({ commandId }, 202)
  })
  /** Внешние адреса пиров WireGuard и куда они ходили — только владелец (и из OPS_VPN_VIEWERS, если задан): это адреса людей и их трафик. */
  .get('/agents/:id/vpn', requireRole('owner'), async (c) => {
    const viewers = getEnv().vpnViewers
    if (viewers.length && !viewers.includes(c.get('user').email.toLowerCase())) {
      throw apiError(403, 'Направления VPN видят только адреса из OPS_VPN_VIEWERS')
    }
    const row = await getDb().query.agentVpn.findFirst({ where: eq(agentVpn.agentId, c.req.param('id')) })
    if (!row) return c.json({ vpn: null })
    return c.json({
      vpn: {
        endpoints: JSON.parse(row.endpointsJson) as unknown,
        destinations: JSON.parse(row.destinationsJson) as unknown,
        capturedAt: ms(row.capturedAt),
        updatedAt: row.updatedAt.getTime(),
      },
    })
  })
  /** Домены по конфигурации nginx на хостах (агент ≥ 1.5) — то же, что /monitors/tls, но без заведённого монитора. */
  .get('/domains', async (c) => {
    const db = getDb()
    const [rows, names] = await Promise.all([
      db.query.agentDomains.findMany({ orderBy: [asc(agentDomains.domain), asc(agentDomains.agentId)], limit: 2000 }),
      db.select({ id: agents.id, name: agents.name }).from(agents).limit(50),
    ])
    const agentName = new Map(names.map((a) => [a.id, a.name]))
    return c.json({
      domains: rows.map((r) => ({
        ...r,
        agentName: agentName.get(r.agentId) ?? r.agentId,
        daysLeft: daysLeft(r.validTo),
        validTo: ms(r.validTo),
        checkedAt: ms(r.checkedAt),
        updatedAt: r.updatedAt.getTime(),
      })),
    })
  })
  .get('/commands', async (c) => {
    const { limit } = parseQuery(c, z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }))
    const rows = await getDb().query.commands.findMany({ orderBy: desc(commands.requestedAt), limit })
    return c.json({
      commands: rows.map((x) => ({ ...x, requestedAt: x.requestedAt.getTime(), claimedAt: ms(x.claimedAt), finishedAt: ms(x.finishedAt) })),
    })
  })
