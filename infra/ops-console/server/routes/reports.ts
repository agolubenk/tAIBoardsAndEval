/** Отчёты для ИИ-совета директоров: история, предпросмотр, ручная отправка. */
import { Hono } from 'hono'
import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/client'
import { reports } from '../db/schema'
import { apiError, type AppEnv } from '../http-types'
import { requireRole } from '../auth/middleware'
import { parseBody, parseId } from '../lib/validate'
import { buildReport } from '../reports/build'
import { generateAndSend } from '../reports/deliver'

const periodSchema = z.object({ period: z.enum(['daily', 'weekly']).default('daily') })

export const reportRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const rows = await getDb()
      .select({
        id: reports.id,
        period: reports.period,
        periodStart: reports.periodStart,
        periodEnd: reports.periodEnd,
        deliveryStatus: reports.deliveryStatus,
        deliveryError: reports.deliveryError,
        createdBy: reports.createdBy,
        createdAt: reports.createdAt,
      })
      .from(reports)
      .orderBy(desc(reports.createdAt))
      .limit(60)
    return c.json({
      reports: rows.map((r) => ({
        ...r,
        periodStart: r.periodStart.getTime(),
        periodEnd: r.periodEnd.getTime(),
        createdAt: r.createdAt.getTime(),
      })),
    })
  })
  .get('/:id', async (c) => {
    const row = await getDb().query.reports.findFirst({ where: eq(reports.id, parseId(c.req.param('id'))) })
    if (!row) throw apiError(404, 'Отчёт не найден')
    return c.json({
      id: row.id,
      deliveryStatus: row.deliveryStatus,
      deliveryError: row.deliveryError,
      createdAt: row.createdAt.getTime(),
      report: JSON.parse(row.payloadJson) as unknown,
    })
  })
  .post('/preview', async (c) => {
    const { period } = await parseBody(c, periodSchema)
    return c.json({ report: await buildReport(period) })
  })
  .post('/send', requireRole('operator'), async (c) => {
    const { period } = await parseBody(c, periodSchema)
    return c.json(await generateAndSend(period, c.get('user').email))
  })
