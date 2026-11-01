/** Лента событий и деплои. */
import { Hono } from 'hono'
import { and, desc, eq, gte, lt, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/client'
import { activity, deploys } from '../db/schema'
import { apiError, type AppEnv } from '../http-types'
import { requireRole } from '../auth/middleware'
import { incidentsAfterDeploys } from '../incidents/facts'
import { deploySyncSchema, syncGithubDeploys } from '../deploys/github'
import { liveDeploy } from '../deploys/progress'
import { queueLinksForDeploys } from '../deploys/queue-links'
import { getGithubSettings, readSetting } from '../settings/store'
import { HTTPException } from 'hono/http-exception'
import { parseQuery } from '../lib/validate'

const ms = (d: Date | null | undefined) => (d ? d.getTime() : null)

const activityQuery = z.object({
  kind: z.enum(['alert', 'incident', 'action', 'config', 'deploy', 'agent', 'report', 'auth']).optional(),
  before: z.coerce.number().int().positive().optional(),
  /** Окно: последние N часов (24 — сутки, 168 — неделя). */
  hours: z.coerce.number().int().min(1).max(24 * 90).optional(),
  /** Поиск по тексту и автору (подстрока). */
  q: z.string().trim().max(100).optional(),
  /** События объекта: маршрут начинается с … (страница хоста). */
  route: z
    .string()
    .regex(/^\/[A-Za-z0-9/_.%?=&-]{0,200}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(60),
})

/** LIKE-шаблон с экранированием %, _ и обратной косой черты — поиск по подстроке, а не по маске. */
const likeEscape = (v: string) => v.replace(/[\\%_]/g, (ch) => `\\${ch}`)

function activityWhere(q: z.infer<typeof activityQuery>) {
  return and(
    q.kind ? eq(activity.kind, q.kind) : undefined,
    q.before ? lt(activity.createdAt, new Date(q.before)) : undefined,
    q.hours ? gte(activity.createdAt, new Date(Date.now() - q.hours * 3_600_000)) : undefined,
    q.q
      ? or(
          sql`${activity.message} like ${`%${likeEscape(q.q)}%`} escape '\\'`,
          sql`${activity.actor} like ${`%${likeEscape(q.q)}%`} escape '\\'`,
        )
      : undefined,
    q.route ? sql`${activity.route} like ${`${likeEscape(q.route)}%`} escape '\\'` : undefined,
  )
}

/** Ячейка CSV: кавычки удваиваются; =,+,-,@ в начале — апостроф (формула в Excel не выполнится). */
export function csvCell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v
  return `"${safe.replace(/"/g, '""')}"`
}

export const eventRoutes = new Hono<AppEnv>()
  .get('/activity', async (c) => {
    const q = parseQuery(c, activityQuery)
    const rows = await getDb().query.activity.findMany({ where: activityWhere(q), orderBy: desc(activity.createdAt), limit: q.limit })
    return c.json({
      events: rows.map((e) => ({ ...e, createdAt: e.createdAt.getTime() })),
      nextBefore: rows.length === q.limit ? (rows.at(-1)?.createdAt.getTime() ?? null) : null,
    })
  })
  /** Экспорт ленты в CSV (те же фильтры, до 5000 строк). UTF-8 с BOM — Excel откроет кириллицу. */
  .get('/activity.csv', async (c) => {
    const q = parseQuery(c, activityQuery)
    const rows = await getDb().query.activity.findMany({ where: activityWhere(q), orderBy: desc(activity.createdAt), limit: 5000 })
    const lines = [
      ['время (UTC)', 'тип', 'событие', 'кто', 'ссылка'].map(csvCell).join(','),
      ...rows.map((e) => [e.createdAt.toISOString(), e.kind, e.message, e.actor, e.route].map(csvCell).join(',')),
    ]
    const name = `ops-events-${new Date().toISOString().slice(0, 10)}.csv`
    return c.body(`\uFEFF${lines.join('\r\n')}\r\n`, 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    })
  })
  .get('/deploys', async (c) => {
    const rows = await getDb().query.deploys.findMany({ orderBy: desc(deploys.createdAt), limit: 50 })
    // Очередь владельца — только роли owner: у остальных ролей прав на очередь нет (server/queue/auth.ts).
    const owner = c.get('user').role === 'owner'
    const ghSettings = getGithubSettings()
    const [linked, gh, sync, queue] = await Promise.all([
      incidentsAfterDeploys(rows),
      ghSettings,
      readSetting('deploy_sync', deploySyncSchema),
      // Ссылки на PR в пунктах — только своего репозитория: «pull/404» чужого репо — не наш #404.
      owner ? ghSettings.then((g) => queueLinksForDeploys(rows, /^[\w.-]+\/[\w.-]+$/.test(g.repo) ? g.repo : '')) : null,
    ])
    const timed = rows.filter((d) => d.startedAt && d.finishedAt && d.conclusion === 'success').slice(0, 14)
    const avgMs = timed.length ? timed.reduce((sum, d) => sum + (d.finishedAt!.getTime() - d.startedAt!.getTime()), 0) / timed.length : null
    return c.json({
      deploys: rows.map((d) => ({
        ...d,
        startedAt: ms(d.startedAt),
        finishedAt: ms(d.finishedAt),
        createdAt: d.createdAt.getTime(),
        incident: linked.get(d.id) ?? null,
        ...(queue ? { queue: queue.get(d.id) ?? null } : {}),
      })),
      source: {
        configured: /^[\w.-]+\/[\w.-]+$/.test(gh.repo) && /^[\w.-]+$/.test(gh.workflow),
        repo: gh.repo,
        workflow: gh.workflow,
        lastSyncAt: sync.at || null,
        lastSyncOk: sync.ok,
        lastSyncError: sync.error,
      },
      avgDurationMs: avgMs,
      avgOf: timed.length,
    })
  })
  /** Живая карточка текущего или последнего деплоя (события contabo-deploy.sh); видит и наблюдатель. */
  .get('/deploys/live', async (c) => c.json(await liveDeploy()))
  /** «Синхронизировать»: опросить GitHub сейчас, не дожидаясь планировщика (раз в 2 мин). */
  .post('/deploys/sync', requireRole('operator'), async (c) => {
    try {
      const r = await syncGithubDeploys()
      if (r === 'not_configured') throw apiError(400, 'GitHub не настроен: Настройки → Интеграции')
    } catch (err) {
      if (err instanceof HTTPException) throw err
      throw apiError(503, err instanceof Error ? err.message : 'GitHub не ответил')
    }
    return c.json({ ok: true })
  })
