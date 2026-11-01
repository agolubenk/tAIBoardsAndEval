/**
 * Живой ход деплоя: приём событий contabo-deploy.sh (POST /api/agent/deploy-events), карточка для
 * «Деплоев» и хранение. Событие несёт накопленную сводку, поэтому карточка собирается идемпотентно:
 * сводка — от события с наибольшим seq, повтор и потеря середины её не портят.
 */
import { and, count, desc, eq, gt, gte, lt, lte, notInArray } from 'drizzle-orm'
import { getDb } from '../db/client'
import { agents, deployProgress, deploys } from '../db/schema'
import { apiError } from '../http-types'
import type { DeployCard, DeployEvent, DeployLiveResponse } from '../../shared/deploy-events-contract'
import { buildDeployCard, matchRun, parseEvents, type EventLogEntry } from './card'

const DAY = 86_400_000
const HOUR = 3_600_000
/** Новых карточек от одного агента за час. Настоящий деплой — одна: больше — сбой или подделка, БД не раздуваем. */
const MAX_NEW_PER_HOUR = 30
/**
 * Хранение: 90 дней — как лента событий по умолчанию — и не больше 200 карточек при любой частоте деплоев.
 * Карточка — 2–4 КБ, так что это ≤ 1 МБ даже на Turso free.
 */
export const DEPLOY_PROGRESS_MAX_AGE_DAYS = 90
export const DEPLOY_PROGRESS_KEEP = 200
/** Событий одного деплоя — 8; запас против бесконечного роста строки. */
const MAX_EVENTS_LOG = 32

export async function recordDeployEvent(agentId: string, ts: number, ev: DeployEvent, now = Date.now()): Promise<{ duplicate: boolean }> {
  const startedMs = ev.startedAt * 1000
  if (startedMs < now - DAY || startedMs > now + 5 * 60_000) {
    throw apiError(400, 'Старт деплоя не в пределах последних суток (проверьте часы сервера)')
  }
  const db = getDb()
  const final = ev.type === 'deploy_done'
  const summaryJson = JSON.stringify({ phases: ev.phases, checks: ev.checks, rollback: ev.rollback })
  const entry: EventLogEntry = { seq: ev.seq, type: ev.type, at: ev.at }
  const outcome = {
    status: final ? (ev.rc === 0 ? ('success' as const) : ('failed' as const)) : ('running' as const),
    rc: final ? ev.rc : null,
    finishedAt: final ? new Date(ev.at * 1000) : null,
  }
  const key = and(eq(deployProgress.agentId, agentId), eq(deployProgress.deployId, ev.deployId))

  let row = await db.query.deployProgress.findFirst({ where: key })
  if (!row) {
    const [recent] = await db
      .select({ n: count() })
      .from(deployProgress)
      .where(and(eq(deployProgress.agentId, agentId), gt(deployProgress.createdAt, new Date(now - HOUR))))
    if ((recent?.n ?? 0) >= MAX_NEW_PER_HOUR) throw apiError(429, 'Слишком много новых деплоев от агента за час')
    const inserted = await db
      .insert(deployProgress)
      .values({
        agentId,
        deployId: ev.deployId,
        sha: ev.sha,
        ...outcome,
        startedAt: new Date(startedMs),
        summaryJson,
        eventsJson: JSON.stringify([entry]),
        lastSeq: ev.seq,
        lastEventTs: ts,
        lastEventAt: new Date(now),
        createdAt: new Date(now),
      })
      .onConflictDoNothing()
      .returning({ id: deployProgress.id })
    if (inserted.length) return { duplicate: false }
    // Карточку только что создал параллельный запрос того же деплоя — дальше как обновление.
    row = await db.query.deployProgress.findFirst({ where: key })
    if (!row) throw apiError(409, 'Карточку деплоя меняет другой запрос — повторите')
  }

  // Повтор подписанного запроса (та же или более старая метка) не проходит — как у отчётов агента.
  if (ts <= row.lastEventTs) throw apiError(409, 'Повтор события деплоя отклонён')
  const events = parseEvents(row.eventsJson)
  const known = events.some((e) => e.seq === ev.seq)
  const set: Partial<typeof deployProgress.$inferInsert> = { lastEventTs: ts, lastEventAt: new Date(now) }
  if (!known) set.eventsJson = JSON.stringify([...events, entry].sort((a, b) => a.seq - b.seq).slice(-MAX_EVENTS_LOG))
  // Сводку даёт только более позднее событие: опоздавшее старое её не откатывает.
  if (ev.seq > row.lastSeq) {
    set.lastSeq = ev.seq
    set.summaryJson = summaryJson
    // Итог фиксируется один раз.
    if (row.status === 'running') Object.assign(set, outcome)
  }
  const updated = await db
    .update(deployProgress)
    .set(set)
    .where(and(eq(deployProgress.id, row.id), eq(deployProgress.lastEventTs, row.lastEventTs)))
    .returning({ id: deployProgress.id })
  if (!updated.length) throw apiError(409, 'Карточку деплоя меняет другой запрос — повторите')
  return { duplicate: known }
}

/** Последний по старту деплой: деплои идут по одному, так что он и есть текущий. */
export async function latestDeployRow() {
  return getDb().query.deployProgress.findFirst({ orderBy: [desc(deployProgress.startedAt), desc(deployProgress.id)] })
}

/** Карточка строки: имя агента и запуск GitHub рядом по времени (по нему же — «прервался»). */
export async function deployCardFor(row: typeof deployProgress.$inferSelect, now = Date.now()): Promise<DeployCard> {
  const db = getDb()
  const startedMs = row.startedAt.getTime()
  const [agent, runs] = await Promise.all([
    db.query.agents.findFirst({ where: eq(agents.id, row.agentId), columns: { name: true } }),
    db.query.deploys.findMany({
      where: and(gte(deploys.startedAt, new Date(startedMs - 3 * HOUR)), lte(deploys.startedAt, new Date(startedMs + 3 * HOUR))),
      orderBy: desc(deploys.startedAt),
      limit: 20,
    }),
  ])
  return buildDeployCard(row, agent?.name ?? row.agentId, matchRun(row.sha, startedMs, runs), now)
}

/** Текущий или последний деплой. */
export async function liveDeploy(now = Date.now()): Promise<DeployLiveResponse> {
  const row = await latestDeployRow()
  return { serverTime: now, card: row ? await deployCardFor(row, now) : null }
}

/** Ретенция — в ежедневной чистке планировщика (server/scheduler/tick.ts). */
export async function pruneDeployProgress(now = Date.now()): Promise<void> {
  const db = getDb()
  await db.delete(deployProgress).where(lt(deployProgress.startedAt, new Date(now - DEPLOY_PROGRESS_MAX_AGE_DAYS * DAY)))
  const newest = db
    .select({ id: deployProgress.id })
    .from(deployProgress)
    .orderBy(desc(deployProgress.startedAt), desc(deployProgress.id))
    .limit(DEPLOY_PROGRESS_KEEP)
  await db.delete(deployProgress).where(notInArray(deployProgress.id, newest))
}
