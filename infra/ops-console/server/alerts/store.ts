/**
 * Жизненный цикл алерта по наблюдению: «за порогом / в норме» → счётчик подряд (rule_streaks)
 * → срабатывание, повтор, восстановление. Один активный алерт на fingerprint.
 * Критический алерт открывает инцидент (или присоединяется к активному по тому же объекту).
 *
 * Наблюдение несёт контекст для людей — факты, подсказку, ссылки и описание восстановления;
 * он сохраняется в алерте и обновляется при каждом наблюдении, поэтому и повторное
 * уведомление, и «восстановлено» показывают свежие данные, а не значения момента срабатывания.
 */
import { and, eq, inArray, sql } from 'drizzle-orm'
import { getDb } from '../db/client'
import { alertRules, alerts, incidents, ruleStreaks } from '../db/schema'
import { logActivity } from '../activity'
import { maintenanceForRoute } from '../maintenance/store'
import { addIncidentEvent, maybeAutoResolve, openIncident } from '../incidents/store'
import { consoleLink, notifyAlert, refreshAlertCards } from '../notify/dispatch'
import type { AlertMessage, NotifyEvent } from '../notify/format'
import { getGeneralSettings } from '../settings/store'
import { collectStableFlaps, isFlapping, onFire } from './flap'

export type AlertRule = typeof alertRules.$inferSelect
type AlertRow = typeof alerts.$inferSelect

export type Fact = [label: string, value: string]

export interface Observation {
  rule: Pick<AlertRule, 'id' | 'forSamples' | 'severity' | 'repeatMin'>
  fingerprint: string
  breached: boolean
  title: string
  object: string
  detail?: string
  /** Короткая сводка состояния: «нет отчётов 3 мин», «HTTP 503», «92%». */
  value?: string
  route?: string
  facts?: Fact[]
  hint?: string
  links?: Fact[]
  /** Как выглядит восстановление (если наблюдение «в норме»): «снова на связи, отчёт 15:08:12». */
  recovery?: string
}

export type ObserveOutcome = 'fired' | 'updated' | 'repeated' | 'resolved' | 'pending' | 'ok' | 'maintenance'

/** Ключ счётчика «в норме подряд» рядом со счётчиком «за порогом подряд». */
const okKey = (fingerprint: string) => `ok:${fingerprint}`

async function bumpStreak(fingerprint: string): Promise<number> {
  const [row] = await getDb()
    .insert(ruleStreaks)
    .values({ fingerprint, streak: 1, updatedAt: new Date() })
    .onConflictDoUpdate({ target: ruleStreaks.fingerprint, set: { streak: sql`${ruleStreaks.streak} + 1`, updatedAt: new Date() } })
    .returning({ streak: ruleStreaks.streak })
  return row?.streak ?? 1
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const clipPairs = (v: Fact[] | undefined): Fact[] => (v ?? []).slice(0, 12).map(([k, x]) => [clip(k, 60), clip(x, 300)])
const pairs = (v: Fact[] | undefined) => JSON.stringify(clipPairs(v))

function contextColumns(o: Observation) {
  return {
    ...(o.facts ? { factsJson: pairs(o.facts) } : {}),
    ...(o.hint !== undefined ? { hint: clip(o.hint, 600) } : {}),
    ...(o.links ? { linksJson: pairs(o.links) } : {}),
  }
}

/** Метрики нет в отчёте: «N наблюдений подряд» с разрывом — уже не подряд, оба счётчика с нуля. */
export async function resetStreaks(fingerprint: string): Promise<void> {
  await getDb()
    .delete(ruleStreaks)
    .where(inArray(ruleStreaks.fingerprint, [fingerprint, okKey(fingerprint)]))
}

export async function observe(o: Observation): Promise<ObserveOutcome> {
  const db = getDb()
  const active = await db.query.alerts.findFirst({ where: and(eq(alerts.fingerprint, o.fingerprint), eq(alerts.status, 'firing')) })

  if (!o.breached) {
    await db.delete(ruleStreaks).where(eq(ruleStreaks.fingerprint, o.fingerprint))
    if (!active) return 'ok'
    // Закрытие симметрично срабатыванию — N наблюдений «в норме» подряд: метрика, гуляющая
    // у порога, не открывает и не закрывает алерт на каждом отчёте.
    if ((await bumpStreak(okKey(o.fingerprint))) < o.rule.forSamples) return 'pending'
    // Уведомление о восстановлении показывает факты и ссылки наблюдения «в норме», а не последнего
    // «за порогом» (иначе восстановление деплоя несло коммит и ссылку упавшего запуска, а «5xx в
    // nginx» — «сейчас: 24»). Строка алерта их не перезаписывает: в истории остаётся, что сломалось.
    await resolveAlert(active, o.recovery || 'вернулось в норму', 'system', {
      ...(o.facts ? { facts: clipPairs(o.facts) } : {}),
      ...(o.links ? { links: clipPairs(o.links) } : {}),
    })
    return 'resolved'
  }

  // Техработы: не поднимать и не повторять. Счётчик «подряд» сбрасывается — после окна алерт
  // откроется заново через обычные N наблюдений, если проблема осталась. Счётчик «в норме» —
  // тоже: сбой в окне всё ещё сбой, иначе горящий алерт закрылся бы по разрозненным хорошим
  // отчётам («восстановлено» посреди работ и новый инцидент после окна).
  if (await maintenanceForRoute(o.route)) {
    await db.delete(ruleStreaks).where(inArray(ruleStreaks.fingerprint, [o.fingerprint, okKey(o.fingerprint)]))
    return 'maintenance'
  }
  await db.delete(ruleStreaks).where(eq(ruleStreaks.fingerprint, okKey(o.fingerprint)))
  const streak = await bumpStreak(o.fingerprint)
  const now = new Date()
  if (active) {
    const [fresh] = await db
      .update(alerts)
      .set({
        lastSeenAt: now,
        value: clip(o.value ?? active.value, 120),
        detail: clip(o.detail ?? active.detail, 500),
        breachStreak: streak,
        ...contextColumns(o),
      })
      // Алерт могли закрыть вручную между чтением и записью — тогда без повтора: иначе
      // опоздавший «ВСЁ ЕЩЁ ГОРИТ» переписал бы итоговую карточку в Telegram.
      .where(and(eq(alerts.id, active.id), eq(alerts.status, 'firing')))
      .returning()
    if (!fresh) return 'updated'
    const silenced = active.silencedUntil && active.silencedUntil.getTime() > now.getTime()
    const due = !active.lastNotifiedAt || now.getTime() - active.lastNotifiedAt.getTime() >= o.rule.repeatMin * 60_000
    if (!active.acknowledgedAt && !silenced && due && o.rule.repeatMin > 0) {
      await sendNotification(fresh, 'repeat')
      return 'repeated'
    }
    return 'updated'
  }
  if (streak < o.rule.forSamples) return 'pending'
  await fireAlert(o, streak)
  return 'fired'
}

async function fireAlert(o: Observation, streak: number): Promise<void> {
  const db = getDb()
  const now = new Date()
  const [row] = await db
    .insert(alerts)
    .values({
      fingerprint: o.fingerprint,
      ruleId: o.rule.id,
      severity: o.rule.severity,
      title: clip(o.title, 190),
      object: clip(o.object, 190),
      detail: clip(o.detail ?? '', 500),
      value: clip(o.value ?? '', 120),
      route: o.route ?? '',
      status: 'firing',
      breachStreak: streak,
      startedAt: now,
      lastSeenAt: now,
      factsJson: pairs(o.facts),
      hint: clip(o.hint ?? '', 600),
      linksJson: pairs(o.links),
    })
    .returning()
  if (!row) return
  await logActivity(
    'alert',
    `${o.rule.severity === 'critical' ? '🔴' : '🟠'} ${o.title} — ${o.object}`,
    'system',
    `/alerts?focus=${row.id}`,
  )
  if (o.rule.severity === 'critical') await attachToIncident(row)
  const flap = await onFire(o.fingerprint)
  const current = (await db.query.alerts.findFirst({ where: eq(alerts.id, row.id) })) ?? row
  if (!flap.notify) {
    // Мигает, и уведомление «мигает» уже уходило в последние 30 мин — молчим, но помечаем
    // как отправленное: повтор по правилу считается от этого момента.
    await db.update(alerts).set({ lastNotifiedAt: new Date() }).where(eq(alerts.id, row.id))
    return
  }
  await sendNotification(current, flap.flapping ? 'flapping' : 'firing', { flapCount: flap.count })
}

async function attachToIncident(alert: AlertRow): Promise<void> {
  const db = getDb()
  // Тот же объект уже в активном инциденте — присоединяемся, а не плодим инциденты на каждый симптом.
  const sibling = await db
    .select({ incidentId: alerts.incidentId })
    .from(alerts)
    .innerJoin(incidents, eq(incidents.id, alerts.incidentId))
    .where(and(eq(alerts.object, alert.object), eq(alerts.status, 'firing'), eq(incidents.status, 'active')))
    .limit(1)
  const incidentId =
    sibling[0]?.incidentId ??
    (await openIncident({ title: `${alert.title}: ${alert.object}`, severity: alert.severity, summary: alert.detail || alert.title }))
  await db.update(alerts).set({ incidentId }).where(eq(alerts.id, alert.id))
  await addIncidentEvent(incidentId, 'alert', `Алерт: ${alert.title} — ${alert.object}${alert.value ? ` (${alert.value})` : ''}`)
}

/**
 * Закрыть алерт. actor === 'system' — восстановилось по наблюдению (reason — как именно),
 * иначе — закрыт оператором вручную: это не восстановление, и уведомление говорит об этом прямо.
 */
export async function resolveAlert(
  alert: AlertRow,
  reason: string,
  actor = 'system',
  /** Факты и ссылки наблюдения «в норме» — только для уведомления, в строку алерта не пишутся. */
  recovery: { facts?: Fact[]; links?: Fact[] } = {},
): Promise<void> {
  const db = getDb()
  const manual = actor !== 'system'
  const [closed] = await db
    .update(alerts)
    .set({
      status: 'resolved',
      resolvedAt: new Date(),
      resolvedBy: manual ? actor : null,
      resolution: manual ? '' : clip(reason, 300),
    })
    .where(eq(alerts.id, alert.id))
    .returning()
  await db.delete(ruleStreaks).where(inArray(ruleStreaks.fingerprint, [alert.fingerprint, okKey(alert.fingerprint)]))
  await logActivity(
    'alert',
    manual ? `⚪ ${alert.title} — ${alert.object}: закрыт вручную` : `🟢 ${alert.title} — ${alert.object}: ${reason}`,
    actor,
    `/alerts?focus=${alert.id}`,
  )
  // Восстановление шлём, только если о срабатывании сообщали, и не шлём, пока алерт мигает
  // (о том, что всё успокоилось, скажет уведомление «стабильно»). Карточку в Telegram при этом
  // всё равно переписываем в итог — молча: иначе «〰️ МИГАЕТ … обновлено» висела бы вечно.
  const event = manual ? 'closed' : 'resolved'
  const extra: Partial<AlertMessage> = {
    ...(recovery.facts ? { facts: recovery.facts } : {}),
    ...(recovery.links ? { links: recovery.links } : {}),
  }
  if (alert.lastNotifiedAt && (manual || !(await isFlapping(alert.fingerprint)))) {
    await sendNotification(closed ?? alert, event, extra)
  } else if (alert.lastNotifiedAt) {
    await refreshAlertCards(await buildMessage(closed ?? alert, event, extra))
  }
  if (alert.incidentId) {
    await addIncidentEvent(
      alert.incidentId,
      'alert',
      manual ? `Закрыт вручную: ${alert.title} — ${alert.object}` : `Восстановлено: ${alert.title} — ${alert.object} (${reason})`,
      actor,
    )
    await maybeAutoResolve(alert.incidentId)
  }
}

function parsePairs(json: string): Array<[string, string]> {
  try {
    const v: unknown = JSON.parse(json)
    return Array.isArray(v)
      ? v.filter((p): p is [string, string] => Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'string')
      : []
  } catch {
    return []
  }
}

export async function buildMessage(alert: AlertRow, event: NotifyEvent, extra: Partial<AlertMessage> = {}): Promise<AlertMessage> {
  const { timezone } = await getGeneralSettings()
  const rule = alert.ruleId
    ? await getDb().query.alertRules.findFirst({ where: eq(alertRules.id, alert.ruleId), columns: { kind: true } })
    : null
  return {
    kind: rule?.kind ?? null,
    event,
    alertId: alert.id,
    severity: alert.severity,
    title: alert.title,
    object: alert.object,
    value: alert.value,
    detail: alert.detail,
    facts: parsePairs(alert.factsJson),
    hint: alert.hint,
    links: parsePairs(alert.linksJson),
    link: consoleLink(alert.route || `/alerts?focus=${alert.id}`),
    startedAt: alert.startedAt.getTime(),
    resolvedAt: alert.resolvedAt?.getTime() ?? null,
    resolution: alert.resolution,
    closedBy: alert.resolvedBy,
    incidentId: alert.incidentId,
    timeZone: timezone,
    acknowledgedBy: alert.acknowledgedBy,
    acknowledgedAt: alert.acknowledgedAt?.getTime() ?? null,
    silencedUntil: alert.silencedUntil?.getTime() ?? null,
    ...extra,
  }
}

async function sendNotification(alert: AlertRow, event: NotifyEvent, extra: Partial<AlertMessage> = {}): Promise<void> {
  const silenced = alert.silencedUntil && alert.silencedUntil.getTime() > Date.now()
  if (silenced && (event === 'firing' || event === 'repeat' || event === 'flapping')) return
  try {
    await notifyAlert(await buildMessage(alert, event, extra))
  } finally {
    // Отметка ставится и при сбое доставки: иначе каждый тик повторял бы попытку в сломанный канал.
    if (event === 'firing' || event === 'repeat' || event === 'flapping') {
      await getDb().update(alerts).set({ lastNotifiedAt: new Date() }).where(eq(alerts.id, alert.id))
    }
  }
}

/** Из тика: мигавшие алерты, которые 15 мин не срабатывали, — одно уведомление «стабильно». */
export async function notifyStableFlaps(): Promise<number> {
  const stable = await collectStableFlaps()
  for (const s of stable) await sendNotification(s.alert, 'stable', { flapCount: s.fires, quietMin: s.quietMin })
  return stable.length
}

/** Встроенные правила (создаются один раз; владелец может менять пороги и выключать). */
export async function getRulesByKind(kind: AlertRule['kind']): Promise<AlertRule[]> {
  return getDb().query.alertRules.findMany({ where: and(eq(alertRules.kind, kind), eq(alertRules.enabled, true)), limit: 100 })
}
