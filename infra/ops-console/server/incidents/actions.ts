/** Действия над инцидентом — из консоли и из Telegram-бота (один путь, один журнал). */
import { and, eq, isNull, ne } from 'drizzle-orm'
import { getDb } from '../db/client'
import { alerts, incidents } from '../db/schema'
import { ackAlert, refreshCardsAfterAction } from '../alerts/actions'
import { addIncidentEvent } from './store'

/**
 * «Подтвердить»: все горящие алерты инцидента — в работу, без ответственного — взять себе
 * (условный UPDATE: при одновременном нажатии ответственным станет один). null — инцидента нет.
 * refreshCards=false — правку карточек алертов в Telegram вызывающий сделает сам (после ответа
 * на нажатие кнопки).
 */
export async function ackIncident(
  id: number,
  actor: string,
  opts: { via?: string; refreshCards?: boolean } = {},
): Promise<{ acked: number; assigned: boolean; closed: boolean; rows: Array<typeof alerts.$inferSelect> } | null> {
  const db = getDb()
  const inc = await db.query.incidents.findFirst({ where: eq(incidents.id, id) })
  if (!inc) return null
  // Закрытый не берут: старая кнопка «Беру инцидент» не должна переоткрывать ответственность.
  if (inc.status === 'resolved') return { acked: 0, assigned: false, closed: true, rows: [] }
  const firing = await db.query.alerts.findMany({ where: and(eq(alerts.incidentId, id), eq(alerts.status, 'firing')), limit: 50 })
  const changed: Array<typeof alerts.$inferSelect> = []
  for (const a of firing) {
    const done = await ackAlert(a.id, actor, opts.via ?? '')
    if (done && !done.already) {
      changed.push(done.row)
      if (opts.refreshCards !== false) await refreshCardsAfterAction(done.row)
    }
  }
  const [took] = await db
    .update(incidents)
    .set({ assignee: actor, assignedAt: new Date() })
    .where(and(eq(incidents.id, id), isNull(incidents.assignee), ne(incidents.status, 'resolved')))
    .returning({ id: incidents.id })
  if (took) await addIncidentEvent(id, 'action', `${actor} подтвердил(а) инцидент и взял(а) его${opts.via ?? ''}`, actor)
  return { acked: changed.length, assigned: Boolean(took), closed: false, rows: changed }
}
