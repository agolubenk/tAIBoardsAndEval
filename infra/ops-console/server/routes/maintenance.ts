/** Техработы: список активных и недавних окон, включение (оператор и выше), досрочное завершение. */
import { Hono } from 'hono'
import { and, desc, eq, gt, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/client'
import { agents, maintenanceWindows, monitors } from '../db/schema'
import { apiError, type AppEnv } from '../http-types'
import { requireRole } from '../auth/middleware'
import { parseBody, parseId } from '../lib/validate'
import { logActivity } from '../activity'
import { invalidateMaintenanceCache, type MaintenanceRow } from '../maintenance/store'

/** Окно техработ для интерфейса (null — работ нет). */
export function maintenanceView(w: MaintenanceRow | null) {
  if (!w) return null
  return {
    id: w.id,
    scope: w.scope,
    target: w.target,
    reason: w.reason,
    startsAt: w.startsAt.getTime(),
    endsAt: w.endsAt.getTime(),
    createdBy: w.createdBy,
    endedAt: w.endedAt?.getTime() ?? null,
    endedBy: w.endedBy,
  }
}

const MAX_MINUTES = 7 * 24 * 60

async function targetName(scope: MaintenanceRow['scope'], target: string): Promise<string | null> {
  if (scope === 'all') return 'вся консоль'
  if (scope === 'agent') return (await getDb().query.agents.findFirst({ where: eq(agents.id, target), columns: { name: true } }))?.name ?? null
  const id = Number(target)
  if (!Number.isInteger(id)) return null
  return (await getDb().query.monitors.findFirst({ where: eq(monitors.id, id), columns: { name: true } }))?.name ?? null
}

export const maintenanceRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const rows = await getDb().query.maintenanceWindows.findMany({
      where: gt(maintenanceWindows.endsAt, new Date(Date.now() - 30 * 86_400_000)),
      orderBy: desc(maintenanceWindows.startsAt),
      limit: 50,
    })
    const names = await Promise.all(rows.map((r) => targetName(r.scope, r.target)))
    return c.json({ windows: rows.map((r, i) => ({ ...maintenanceView(r)!, targetName: names[i] ?? r.target })) })
  })
  .post('/', requireRole('operator'), async (c) => {
    const body = await parseBody(
      c,
      z.object({
        scope: z.enum(['all', 'agent', 'monitor']),
        target: z.string().trim().max(64).default(''),
        minutes: z.number().int().min(5).max(MAX_MINUTES),
        reason: z.string().trim().min(3, 'опишите причину — её увидят все дежурные').max(500),
      }),
    )
    const target = body.scope === 'all' ? '' : body.target
    const name = await targetName(body.scope, target)
    if (!name) throw apiError(404, 'Объект не найден')
    const user = c.get('user')
    // Повторное включение для того же объекта продлевает текущее окно, а не плодит второе.
    const db = getDb()
    const now = new Date()
    const endsAt = new Date(now.getTime() + body.minutes * 60_000)
    const current = await db.query.maintenanceWindows.findFirst({
      where: and(eq(maintenanceWindows.scope, body.scope), eq(maintenanceWindows.target, target), gt(maintenanceWindows.endsAt, now), isNull(maintenanceWindows.endedAt)),
    })
    let row: MaintenanceRow | undefined
    if (current) {
      ;[row] = await db
        .update(maintenanceWindows)
        .set({ endsAt: endsAt > current.endsAt ? endsAt : current.endsAt, reason: body.reason })
        .where(eq(maintenanceWindows.id, current.id))
        .returning()
    } else {
      ;[row] = await db
        .insert(maintenanceWindows)
        .values({ scope: body.scope, target, reason: body.reason, startsAt: now, endsAt, createdBy: user.email, createdAt: now })
        .returning()
    }
    invalidateMaintenanceCache()
    await logActivity('action', `Техработы: ${name} до ${endsAt.toISOString().slice(11, 16)} UTC — ${body.reason}`, user.email, '/settings?tab=maintenance')
    return c.json({ window: maintenanceView(row ?? null) }, current ? 200 : 201)
  })
  .post('/:id/end', requireRole('operator'), async (c) => {
    const id = parseId(c.req.param('id'))
    const user = c.get('user')
    const [row] = await getDb()
      .update(maintenanceWindows)
      .set({ endedAt: new Date(), endedBy: user.email })
      .where(and(eq(maintenanceWindows.id, id), isNull(maintenanceWindows.endedAt), gt(maintenanceWindows.endsAt, new Date())))
      .returning()
    if (!row) throw apiError(404, 'Активное окно техработ не найдено')
    invalidateMaintenanceCache()
    await logActivity('action', `Техработы завершены досрочно: ${(await targetName(row.scope, row.target)) ?? row.target}`, user.email, '/settings?tab=maintenance')
    return c.json({ ok: true })
  })
