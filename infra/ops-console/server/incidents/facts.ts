/**
 * «Связанные факты» инцидента — наблюдения, а не выводы: что менялось рядом по времени. Деплои,
 * завершившиеся за час до начала (и в первые 15 мин), ручные перезапуски в окне инцидента, сбои
 * доставки уведомлений по его алертам. Тот же расчёт — для колонки «Связь» в деплоях.
 */
import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm'
import { getDb } from '../db/client'
import { commands, deliveries, deploys, incidents } from '../db/schema'

const MIN = 60_000
/** Деплой «рядом» с инцидентом: закончился не раньше чем за час до начала и не позже 15 мин после. */
export const DEPLOY_BEFORE_MS = 60 * MIN
export const DEPLOY_AFTER_MS = 15 * MIN

export interface IncidentFact {
  kind: 'deploy' | 'restart' | 'delivery'
  text: string
  /** Минуты от начала инцидента (отрицательные — до). */
  offsetMin: number
  tone: 'neutral' | 'bad'
  url?: string
}

export async function incidentFacts(inc: { startedAt: Date; resolvedAt: Date | null }, alertIds: number[]): Promise<IncidentFact[]> {
  const db = getDb()
  const start = inc.startedAt.getTime()
  const end = inc.resolvedAt?.getTime() ?? Date.now()
  const [deployRows, restartRows, failed] = await Promise.all([
    db.query.deploys.findMany({
      where: and(gte(deploys.finishedAt, new Date(start - DEPLOY_BEFORE_MS)), lte(deploys.finishedAt, new Date(start + DEPLOY_AFTER_MS))),
      orderBy: desc(deploys.finishedAt),
      limit: 5,
    }),
    db.query.commands.findMany({
      where: and(gte(commands.requestedAt, new Date(start - 30 * MIN)), lte(commands.requestedAt, new Date(end))),
      orderBy: desc(commands.requestedAt),
      limit: 10,
    }),
    alertIds.length
      ? db.query.deliveries.findMany({
          where: and(inArray(deliveries.alertId, alertIds), eq(deliveries.ok, false)),
          orderBy: desc(deliveries.createdAt),
          limit: 5,
        })
      : Promise.resolve([]),
  ])
  const off = (d: Date | null) => Math.round(((d?.getTime() ?? start) - start) / MIN)
  const rel = (m: number) => (m < 0 ? `за ${-m} мин до начала` : m === 0 ? 'в момент начала' : `через ${m} мин после начала`)
  const facts: IncidentFact[] = []
  for (const d of deployRows) {
    const m = off(d.finishedAt)
    const ok = d.conclusion === 'success'
    facts.push({
      kind: 'deploy',
      text: `Деплой «${d.title || d.workflow}» ${ok ? 'завершился' : `завершился с ошибкой (${d.conclusion ?? 'неизвестно'})`} ${rel(m)}`,
      offsetMin: m,
      tone: ok ? 'neutral' : 'bad',
      url: d.url || undefined,
    })
  }
  for (const c of restartRows) {
    const m = off(c.requestedAt)
    facts.push({ kind: 'restart', text: `Перезапуск ${c.target} (${c.requestedBy}) ${rel(m)} → ${c.status}`, offsetMin: m, tone: c.status === 'failed' ? 'bad' : 'neutral' })
  }
  for (const f of failed) {
    const m = off(f.createdAt)
    facts.push({ kind: 'delivery', text: `Уведомление не доставлено: ${f.target} — ${f.error ?? 'ошибка'}`, offsetMin: m, tone: 'bad' })
  }
  return facts.sort((a, b) => a.offsetMin - b.offsetMin)
}

/** Для деплоев: инцидент, начавшийся в течение часа после деплоя, — «INC-024 · +4 мин». */
export async function incidentsAfterDeploys(
  rows: Array<{ id: number; finishedAt: Date | null }>,
): Promise<Map<number, { incidentId: number; afterMin: number }>> {
  const done = rows.filter((r) => r.finishedAt)
  if (!done.length) return new Map()
  const times = done.map((r) => r.finishedAt!.getTime())
  const incs = await getDb().query.incidents.findMany({
    where: and(gte(incidents.startedAt, new Date(Math.min(...times) - DEPLOY_AFTER_MS)), lte(incidents.startedAt, new Date(Math.max(...times) + DEPLOY_BEFORE_MS))),
    orderBy: desc(incidents.startedAt),
    limit: 100,
    columns: { id: true, startedAt: true },
  })
  const out = new Map<number, { incidentId: number; afterMin: number }>()
  for (const d of done) {
    const t = d.finishedAt!.getTime()
    const hit = incs
      .filter((i) => i.startedAt.getTime() >= t - DEPLOY_AFTER_MS && i.startedAt.getTime() <= t + DEPLOY_BEFORE_MS)
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())[0]
    if (hit) out.set(d.id, { incidentId: hit.id, afterMin: Math.round((hit.startedAt.getTime() - t) / MIN) })
  }
  return out
}
