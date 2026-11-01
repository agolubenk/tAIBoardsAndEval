/** Инциденты: открываются критическими алертами (или вручную), закрываются восстановлением всех их алертов. */
import { and, eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { alerts, incidentEvents, incidents } from '../db/schema'
import { logActivity } from '../activity'

type EventKind = (typeof incidentEvents.$inferInsert)['kind']

export async function addIncidentEvent(incidentId: number, kind: EventKind, message: string, author = 'system'): Promise<void> {
  await getDb()
    .insert(incidentEvents)
    .values({ incidentId, kind, message: message.slice(0, 2000), author, createdAt: new Date() })
}

export async function openIncident(input: {
  title: string
  severity: 'warning' | 'critical'
  summary?: string
  createdBy?: string
}): Promise<number> {
  const [row] = await getDb()
    .insert(incidents)
    .values({
      title: input.title.slice(0, 190),
      severity: input.severity,
      summary: input.summary ?? '',
      createdBy: input.createdBy ?? 'system',
      startedAt: new Date(),
    })
    .returning({ id: incidents.id })
  if (!row) throw new Error('incident insert failed')
  await addIncidentEvent(row.id, 'opened', input.summary || input.title, input.createdBy ?? 'system')
  await logActivity('incident', `Открыт инцидент #${row.id}: ${input.title}`, input.createdBy ?? 'system', `/incidents/${row.id}`)
  return row.id
}

export type CloseResult = NonNullable<(typeof incidents.$inferSelect)['closeResult']>

export const CLOSE_RESULT_LABEL: Record<CloseResult, string> = {
  fixed: 'устранено',
  false_positive: 'ложное срабатывание',
  accepted_risk: 'принят риск',
}

/** Закрыть инцидент; result/comment — при ручном закрытии (итог и что сделано, как подтверждено). */
export async function resolveIncident(
  incidentId: number,
  reason: string,
  author = 'system',
  close: { result?: CloseResult; comment?: string } = {},
): Promise<void> {
  await getDb()
    .update(incidents)
    .set({ status: 'resolved', resolvedAt: new Date(), closeResult: close.result ?? null, closeComment: close.comment ?? '' })
    .where(eq(incidents.id, incidentId))
  await addIncidentEvent(incidentId, 'resolved', reason, author)
  await logActivity('incident', `Инцидент #${incidentId} закрыт: ${reason}`, author, `/incidents/${incidentId}`)
}

/** Закрыть инцидент, если у него не осталось горящих алертов (и его не перевели вручную в «наблюдение»). */
export async function maybeAutoResolve(incidentId: number): Promise<void> {
  const db = getDb()
  const inc = await db.query.incidents.findFirst({ where: eq(incidents.id, incidentId) })
  if (!inc || inc.status !== 'active') return
  const firing = await db.query.alerts.findFirst({ where: and(eq(alerts.incidentId, incidentId), eq(alerts.status, 'firing')) })
  if (!firing) await resolveIncident(incidentId, 'Все связанные алерты восстановились')
}
