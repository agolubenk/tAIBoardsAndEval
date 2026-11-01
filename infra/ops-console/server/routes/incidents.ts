/** Инциденты: список, карточка с хронологией, ручное открытие, заметки, смена статуса. */
import { Hono } from 'hono'
import { and, asc, count, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/client'
import { alerts, incidentEvents, incidents, users } from '../db/schema'
import { apiError, type AppEnv } from '../http-types'
import { requireRole } from '../auth/middleware'
import { parseBody, parseId, parseQuery } from '../lib/validate'
import { addIncidentEvent, CLOSE_RESULT_LABEL, openIncident, resolveIncident } from '../incidents/store'
import { incidentFacts } from '../incidents/facts'
import { ackIncident } from '../incidents/actions'
import { logActivity } from '../activity'
import { serializeAlert } from './serialize'

const ms = (d: Date | null | undefined) => (d ? d.getTime() : null)
const serialize = (i: typeof incidents.$inferSelect) => ({
  ...i,
  startedAt: i.startedAt.getTime(),
  resolvedAt: ms(i.resolvedAt),
  assignedAt: ms(i.assignedAt),
})

/** Затронуто: сколько алертов (объектов) сгруппировано в инцидент. */
async function affectedCounts(ids: number[]): Promise<Map<number, number>> {
  if (!ids.length) return new Map()
  const rows = await getDb()
    .select({ id: alerts.incidentId, n: count() })
    .from(alerts)
    .where(inArray(alerts.incidentId, ids))
    .groupBy(alerts.incidentId)
  return new Map(rows.map((r) => [r.id ?? 0, r.n]))
}

export const incidentRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const { status } = parseQuery(c, z.object({ status: z.enum(['open', 'resolved', 'all']).default('all') }))
    const where =
      status === 'open'
        ? inArray(incidents.status, ['active', 'monitoring'])
        : status === 'resolved'
          ? eq(incidents.status, 'resolved')
          : undefined
    const rows = await getDb().query.incidents.findMany({ where, orderBy: desc(incidents.startedAt), limit: 100 })
    const affected = await affectedCounts(rows.map((r) => r.id))
    return c.json({ incidents: rows.map((r) => ({ ...serialize(r), affected: affected.get(r.id) ?? 0 })) })
  })
  /** Кому можно назначить: активные учётки с ролью не ниже оператора. */
  .get('/assignees', async (c) => {
    const rows = await getDb().query.users.findMany({ where: eq(users.disabled, false), columns: { email: true, name: true, role: true }, limit: 100 })
    return c.json({ assignees: rows.filter((u) => u.role !== 'viewer').map((u) => ({ email: u.email, name: u.name })) })
  })
  .get('/:id', async (c) => {
    const id = parseId(c.req.param('id'))
    const db = getDb()
    const inc = await db.query.incidents.findFirst({ where: eq(incidents.id, id) })
    if (!inc) throw apiError(404, 'Инцидент не найден')
    const [events, related] = await Promise.all([
      db.query.incidentEvents.findMany({ where: eq(incidentEvents.incidentId, id), orderBy: asc(incidentEvents.createdAt), limit: 500 }),
      db.query.alerts.findMany({ where: eq(alerts.incidentId, id), orderBy: desc(alerts.startedAt), limit: 50 }),
    ])
    const facts = await incidentFacts(inc, related.map((a) => a.id))
    return c.json({
      incident: serialize(inc),
      events: events.map((e) => ({ ...e, createdAt: e.createdAt.getTime() })),
      alerts: related.map(serializeAlert),
      facts,
    })
  })
  .post('/', requireRole('operator'), async (c) => {
    const body = await parseBody(
      c,
      z.object({
        title: z.string().trim().min(3).max(190),
        severity: z.enum(['warning', 'critical']),
        summary: z.string().trim().max(2000).default(''),
      }),
    )
    const id = await openIncident({ ...body, createdBy: c.get('user').email })
    return c.json({ id }, 201)
  })
  .post('/:id/notes', requireRole('operator'), async (c) => {
    const id = parseId(c.req.param('id'))
    const { message } = await parseBody(c, z.object({ message: z.string().trim().min(1).max(2000) }))
    const inc = await getDb().query.incidents.findFirst({ where: eq(incidents.id, id) })
    if (!inc) throw apiError(404, 'Инцидент не найден')
    await addIncidentEvent(id, 'note', message, c.get('user').email)
    return c.json({ ok: true }, 201)
  })
  /** Назначить ответственного (email) или снять (null). «Себе» — email текущего пользователя. */
  .post('/:id/assign', requireRole('operator'), async (c) => {
    const id = parseId(c.req.param('id'))
    const { assignee } = await parseBody(c, z.object({ assignee: z.string().trim().email().max(190).nullable() }))
    const user = c.get('user')
    const inc = await getDb().query.incidents.findFirst({ where: eq(incidents.id, id) })
    if (!inc) throw apiError(404, 'Инцидент не найден')
    if (assignee) {
      const target = await getDb().query.users.findFirst({ where: and(eq(users.email, assignee), eq(users.disabled, false)) })
      if (!target || target.role === 'viewer') throw apiError(400, 'Назначить можно только активную учётку с ролью оператора и выше')
    }
    await getDb()
      .update(incidents)
      .set({ assignee, assignedAt: assignee ? new Date() : null })
      .where(eq(incidents.id, id))
    const text = assignee ? (assignee === user.email ? `${user.email} взял(а) инцидент` : `Назначен ответственный: ${assignee}`) : 'Ответственный снят'
    await addIncidentEvent(id, 'action', text, user.email)
    await logActivity('incident', `Инцидент #${id}: ${text}`, user.email, `/incidents/${id}`)
    return c.json({ ok: true })
  })
  /** «Подтвердить»: все горящие алерты инцидента — в работу; без ответственного — назначить себя. */
  .post('/:id/ack', requireRole('operator'), async (c) => {
    const done = await ackIncident(parseId(c.req.param('id')), c.get('user').email)
    if (!done) throw apiError(404, 'Инцидент не найден')
    if (done.closed) throw apiError(409, 'Инцидент уже закрыт')
    return c.json({ ok: true, acked: done.acked })
  })
  .post('/:id/status', requireRole('operator'), async (c) => {
    const id = parseId(c.req.param('id'))
    const { status, comment, result } = await parseBody(
      c,
      z.object({
        status: z.enum(['active', 'monitoring', 'resolved']),
        comment: z.string().trim().max(2000).default(''),
        result: z.enum(['fixed', 'false_positive', 'accepted_risk']).optional(),
      }),
    )
    const user = c.get('user')
    const inc = await getDb().query.incidents.findFirst({ where: eq(incidents.id, id) })
    if (!inc) throw apiError(404, 'Инцидент не найден')
    if (status === 'resolved') {
      const label = result ? CLOSE_RESULT_LABEL[result] : ''
      const reason = [label && `Итог: ${label}`, comment].filter(Boolean).join(' — ') || 'Закрыт вручную'
      await resolveIncident(id, reason, user.email, { result, comment })
    } else {
      await getDb().update(incidents).set({ status, resolvedAt: null }).where(eq(incidents.id, id))
      await addIncidentEvent(
        id,
        'status',
        `Статус: ${status === 'monitoring' ? 'наблюдение' : 'активен'}${comment ? ` — ${comment}` : ''}`,
        user.email,
      )
    }
    return c.json({ ok: true })
  })
