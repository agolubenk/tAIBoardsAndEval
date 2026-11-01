/** Действия оператора над алертом — из консоли и из кнопок Telegram-бота (один путь, один журнал). */
import { and, eq, isNull } from 'drizzle-orm'
import { getDb } from '../db/client'
import { alertNotes, alerts } from '../db/schema'
import { logActivity } from '../activity'
import { addIncidentEvent } from '../incidents/store'
import { refreshAlertCards } from '../notify/dispatch'
import { buildMessage } from './store'
import { isFlapping, recentFires } from './flap'

export type AlertRow = typeof alerts.$inferSelect

export interface ActionResult {
  row: AlertRow
  /** Ничего не изменилось: уже взят в работу / тишина уже дольше. Журнал и эхо — не повторяются. */
  already: boolean
}

/**
 * Карточки алерта в Telegram — под новое состояние: «В работе: …», «Тишина до …», без нажатой
 * кнопки; мигающий остаётся «мигает». Косметика: сбой правки не отменяет действие. Вызывается после
 * ответа нажавшему (правка всех карточек — секунды, а вебхук с max_connections=1 ждёт).
 */
export async function refreshCardsAfterAction(row: AlertRow): Promise<void> {
  try {
    const flapping = await isFlapping(row.fingerprint)
    const extra = flapping ? { flapCount: await recentFires(row.fingerprint) } : {}
    await refreshAlertCards(await buildMessage(row, flapping ? 'flapping' : 'firing', extra))
  } catch (err) {
    console.warn(`[alerts] карточки алерта #${row.id} не обновить:`, err instanceof Error ? err.message : err)
  }
}

async function firingAlert(id: number): Promise<AlertRow | null> {
  const row = await getDb().query.alerts.findFirst({ where: eq(alerts.id, id) })
  return row?.status === 'firing' ? row : null
}

/**
 * «Взять в работу»: повторные уведомления по алерту прекращаются. Первый взявший остаётся
 * ответственным — повторное нажатие (кнопка в общей группе) его не перезаписывает и журнал не дублирует.
 */
export async function ackAlert(id: number, actor: string, via = ''): Promise<ActionResult | null> {
  const [row] = await getDb()
    .update(alerts)
    .set({ acknowledgedBy: actor, acknowledgedAt: new Date() })
    .where(and(eq(alerts.id, id), eq(alerts.status, 'firing'), isNull(alerts.acknowledgedBy)))
    .returning()
  if (!row) {
    const current = await firingAlert(id)
    return current ? { row: current, already: true } : null
  }
  await logActivity('alert', `Взят в работу${via}: ${row.title} — ${row.object}`, actor, `/alerts?focus=${id}`)
  if (row.incidentId) await addIncidentEvent(row.incidentId, 'note', `${actor} взял(а) алерт в работу${via}: ${row.title}`, actor)
  return { row, already: false }
}

/**
 * «Тишина» на minutes минут (0 — снять). extendOnly — только продлить: кнопка «Тишина 1 ч» в
 * Telegram не должна укоротить тишину на сутки, выставленную в консоли на время работ.
 */
export async function silenceAlert(id: number, minutes: number, actor: string, via = '', opts: { extendOnly?: boolean } = {}): Promise<ActionResult | null> {
  const current = await firingAlert(id)
  if (!current) return null
  const until = minutes === 0 ? null : new Date(Date.now() + minutes * 60_000)
  // «Уже стоит» — с допуском 5 мин: повторное нажатие той же кнопки через минуту ничего не меняет.
  if (opts.extendOnly && until && current.silencedUntil && current.silencedUntil.getTime() >= until.getTime() - 5 * 60_000) {
    return { row: current, already: true }
  }
  const [row] = await getDb()
    .update(alerts)
    .set({ silencedUntil: until })
    .where(and(eq(alerts.id, id), eq(alerts.status, 'firing')))
    .returning()
  if (!row) return null
  await logActivity(
    'alert',
    minutes ? `Тишина ${minutes} мин${via}: ${row.title} — ${row.object}` : `Снята тишина${via}: ${row.title}`,
    actor,
    `/alerts?focus=${id}`,
  )
  return { row, already: false }
}

/** Заметка дежурного к алерту; у алерта в инциденте — ещё и строкой в хронологию инцидента. */
export async function addAlertNote(alert: AlertRow, message: string, author: string): Promise<void> {
  await getDb().insert(alertNotes).values({ alertId: alert.id, author, message: message.slice(0, 2000), createdAt: new Date() })
  if (alert.incidentId) await addIncidentEvent(alert.incidentId, 'note', `${alert.title}: ${message}`, author)
}
