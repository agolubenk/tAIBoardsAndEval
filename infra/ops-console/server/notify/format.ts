/**
 * Тексты уведомлений. Задача сообщения — ответить без захода в консоль: что сломалось, где,
 * с какого времени, насколько всё плохо (факты), что делать (подсказка) и куда нажать.
 * Telegram — HTML с экранированием (parse_mode передаётся всегда), email — тот же текст без
 * разметки, webhook — структурированный JSON.
 */
import { clock, humanDuration } from '../lib/time'

export type NotifyEvent = 'firing' | 'repeat' | 'resolved' | 'closed' | 'flapping' | 'stable'

export interface AlertMessage {
  event: NotifyEvent
  alertId: number
  severity: 'warning' | 'critical'
  title: string
  object: string
  /** Короткая сводка текущего состояния: «нет отчётов 3 мин», «HTTP 503», «92%». */
  value: string
  detail: string
  facts: Array<[string, string]>
  hint: string
  links: Array<[string, string]>
  /** Ссылка на объект в консоли (абсолютная). */
  link: string
  startedAt: number
  resolvedAt: number | null
  resolution: string
  closedBy: string | null
  incidentId: number | null
  /** Сколько раз срабатывал за час (для «мигает» и «стабильно»). */
  flapCount?: number
  /** Сколько минут без сбоев (для «стабильно»). */
  quietMin?: number
  timeZone: string
  now?: number
  /** Вид алерта (правило): иконка рядом с заголовком — что сломалось, видно до чтения. */
  kind?: string | null
  /** Кто взял в работу и когда — строка на карточке, кнопка «Беру в работу» уходит. */
  acknowledgedBy?: string | null
  acknowledgedAt?: number | null
  /** Тишина до (мс): строка на карточке, кнопка «Тишина 1 ч» уходит, пока тишина дольше часа. */
  silencedUntil?: number | null
}

/** Иконка вида алерта (по типу правила). */
export const KIND_ICON: Record<string, string> = {
  host_metric: '🖥',
  container_down: '📦',
  container_unhealthy: '🩺',
  container_restarts: '🔁',
  container_oom: '💾',
  agent_silent: '📡',
  monitor_down: '🌐',
  tls_expiry: '🔒',
  deploy_failed: '🚀',
  deploy_slow: '⏳',
  deploy_rollback_prev: '↩️',
}

const kindIcon = (m: AlertMessage) => (m.kind && KIND_ICON[m.kind] ? `${KIND_ICON[m.kind]} ` : '')

export const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch)

const LEVEL: Record<AlertMessage['severity'], [icon: string, label: string]> = {
  critical: ['🔴', 'КРИТИЧНО'],
  warning: ['🟠', 'ВНИМАНИЕ'],
}

const HEAD: Record<NotifyEvent, (m: AlertMessage) => [icon: string, label: string]> = {
  firing: (m) => LEVEL[m.severity],
  repeat: (m) => [LEVEL[m.severity][0], 'ВСЁ ЕЩЁ ГОРИТ'],
  resolved: () => ['🟢', 'ВОССТАНОВЛЕНО'],
  closed: () => ['⚪️', 'ЗАКРЫТ ВРУЧНУЮ'],
  flapping: () => ['〰️', 'МИГАЕТ'],
  stable: () => ['✅', 'СТАБИЛЬНО'],
}

/**
 * Алерт закончился (восстановлен, закрыт или мигание утихло). Такое сообщение начинается с уровня алерта
 * (🔴/🟠), исход идёт второй строкой. Раньше на закрытии карточку-корень ветки переписывали целиком
 * в «🟢 ВОССТАНОВЛЕНО», и в истории канала после коротких сбоев оставалось только зелёное — владелец
 * не видел, что горело (2026-10-09).
 */
const SETTLED: ReadonlySet<NotifyEvent> = new Set(['resolved', 'closed', 'stable'])

/** «ВОССТАНОВЛЕНО (🔴 критично)» — исход с уровнем алерта, для темы письма и ответа в ветку. */
function outcome(m: AlertMessage, label: string): string {
  return SETTLED.has(m.event) ? `${label} (${LEVEL[m.severity][0]} ${LEVEL[m.severity][1].toLowerCase()})` : label
}

export function alertSubject(m: AlertMessage): string {
  const [icon, label] = HEAD[m.event](m)
  return `${icon} ${outcome(m, label)}: ${kindIcon(m)}${m.title} — ${m.object}`
}

/** Строки сообщения: [текст, жирный?]. Один источник для HTML и plain-text. */
function summary(m: AlertMessage): string {
  switch (m.event) {
    case 'resolved':
      return m.resolution || 'вернулось в норму'
    case 'closed':
      return `закрыто: ${m.closedBy ?? 'оператор'}`
    case 'stable':
      return `${m.quietMin ?? 15} мин без сбоев${m.flapCount ? ` (сбоев за час: ${m.flapCount})` : ''}`
    default:
      return m.value
  }
}

function timeline(m: AlertMessage): string {
  const now = m.now ?? Date.now()
  const tz = m.timeZone
  const since = clock(m.startedAt, tz, now)
  const incident = m.incidentId ? ` · инцидент #${m.incidentId}` : ''
  switch (m.event) {
    case 'firing':
      return `🕒 с ${since}${incident}`
    case 'repeat':
      return `🕒 горит ${humanDuration(now - m.startedAt)} (с ${since})${incident}`
    case 'resolved': {
      const end = m.resolvedAt ?? now
      return `⏱ длилось ${humanDuration(end - m.startedAt)} (${since} → ${clock(end, tz, now)})`
    }
    case 'closed':
      return `⏱ горело ${humanDuration((m.resolvedAt ?? now) - m.startedAt)}. Если причина не устранена, алерт откроется снова при следующей проверке.`
    case 'flapping':
      return `〰️ ${m.flapCount ?? 3}-й сбой за час — сообщения о каждом сбое приостановлены на 30 мин${incident}`
    case 'stable':
      return ''
  }
}

const withHint = (e: NotifyEvent) => e === 'firing' || e === 'repeat' || e === 'flapping'
const withFacts = (e: NotifyEvent) => e !== 'stable' && e !== 'closed'

export function alertText(m: AlertMessage): string {
  const lines = [alertSubject(m), `${m.object} — ${summary(m)}`]
  if (m.detail && withHint(m.event)) lines.push(m.detail)
  if (withFacts(m.event)) for (const [k, v] of m.facts) lines.push(`• ${k}: ${v}`)
  if (m.hint && withHint(m.event)) lines.push(`Что сделать: ${m.hint}`)
  const t = timeline(m)
  if (t) lines.push(t)
  lines.push(`Консоль: ${m.link}`)
  for (const [label, url] of m.links) lines.push(`${label}: ${url}`)
  return lines.join('\n')
}

/** События, которые начинают ветку алерта в канале (новое сообщение-карточка). */
export const THREAD_ROOT_EVENTS: ReadonlySet<NotifyEvent> = new Set(['firing', 'flapping'])

/**
 * Карточка алерта — первое сообщение ветки, переписываемое на месте: пока горит — свежие
 * значения и «обновлено», после закрытия — итог (восстановлено/закрыт, длительность). Уровень
 * алерта (🔴/🟠) остаётся первой строкой и в итоге — см. SETTLED.
 */
export function alertCardHtml(m: AlertMessage): string {
  const html = alertHtml(m)
  if (m.event !== 'firing' && m.event !== 'repeat' && m.event !== 'flapping') return html
  const now = m.now ?? Date.now()
  const state: string[] = []
  if (m.acknowledgedBy) {
    const since = m.acknowledgedAt ? ` с ${clock(m.acknowledgedAt, m.timeZone, now)}` : ''
    state.push(`✋ В работе: ${escapeHtml(m.acknowledgedBy)}${escapeHtml(since)}`)
  }
  if (m.silencedUntil && m.silencedUntil > now) state.push(`🔕 Тишина до ${escapeHtml(clock(m.silencedUntil, m.timeZone, now))}`)
  return `${html}\n${state.length ? `${state.join('\n')}\n` : ''}<i>обновлено ${escapeHtml(clock(now, m.timeZone, m.now, true))}</i>`
}

/** Короткий ответ в ветку: подробности — в карточке, на которую он отвечает. */
export function alertReplyHtml(m: AlertMessage): string {
  const now = m.now ?? Date.now()
  const lasted = humanDuration((m.resolvedAt ?? now) - m.startedAt)
  const [icon, label] = HEAD[m.event](m)
  const tail: Record<NotifyEvent, string> = {
    firing: m.value,
    flapping: m.value,
    repeat: `${m.value} · горит ${lasted}`,
    resolved: `${summary(m)} · длилось ${lasted}`,
    closed: `${summary(m)} · горело ${lasted}`,
    stable: summary(m),
  }
  return `${icon} <b>${escapeHtml(outcome(m, label))}</b> — ${escapeHtml(tail[m.event])}`
}

export function alertHtml(m: AlertMessage): string {
  const [icon, label] = HEAD[m.event](m)
  const object = `<b>${escapeHtml(m.object)}</b> — ${escapeHtml(summary(m))}`
  const lines = SETTLED.has(m.event)
    ? [
        `${LEVEL[m.severity][0]} <b>${escapeHtml(LEVEL[m.severity][1])} · ${kindIcon(m)}${escapeHtml(m.title)}</b>`,
        `${icon} <b>${escapeHtml(label)}</b> · ${object}`,
      ]
    : [`${icon} <b>${escapeHtml(label)} · ${kindIcon(m)}${escapeHtml(m.title)}</b>`, object]
  if (m.detail && withHint(m.event)) lines.push(`<i>${escapeHtml(m.detail)}</i>`)
  if (withFacts(m.event) && m.facts.length) {
    lines.push('')
    for (const [k, v] of m.facts) lines.push(`• ${escapeHtml(k)}: <b>${escapeHtml(v)}</b>`)
  }
  if (m.hint && withHint(m.event)) lines.push('', `💡 ${escapeHtml(m.hint)}`)
  const t = timeline(m)
  if (t) lines.push('', escapeHtml(t))
  const links = [
    `<a href="${escapeHtml(m.link)}">Открыть в консоли</a>`,
    ...m.links.map(([l, url]) => `<a href="${escapeHtml(url)}">${escapeHtml(l)}</a>`),
  ]
  lines.push(links.join(' · '))
  return lines.join('\n')
}
