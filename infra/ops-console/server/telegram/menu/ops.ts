/** Меню: алерты (горящие и закрытые за сутки) и инциденты — списки и карточки с действиями. */
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { agents, alerts, incidentEvents, incidents } from '../../db/schema'
import { alertCardHtml } from '../../notify/format'
import { buildMessage } from '../../alerts/store'
import { isFlapping, recentFires } from '../../alerts/flap'
import { incidentFacts } from '../../incidents/facts'
import { CLOSE_RESULT_LABEL } from '../../incidents/store'
import { clock } from '../../lib/time'
import { plural } from '../../../shared/plural'
import { incidentCode } from '../../../shared/codes'
import { hostKey } from './infra'
import { ago, at, cb, consoleButton, e, fit, navRow, short, type Button, type View, type ViewCtx } from './ui'

const SEV = (s: string) => (s === 'critical' ? '🔴' : '🟠')
const LIST_MAX = 10

type AlertRow = typeof alerts.$inferSelect

/** Кнопка алерта: номер строки списка и объект — заголовок уже в тексте над кнопками. */
function alertButton(a: AlertRow, n?: number): Button {
  return cb(`${a.status === 'firing' ? SEV(a.severity) : '🟢'} ${n ? `${n} · ` : ''}${short(a.object, 30)}`, `m:a:${a.id}`)
}

export async function alertsView(ctx: ViewCtx, resolved = false): Promise<View> {
  const db = getDb()
  const rows = resolved
    ? await db.query.alerts.findMany({
        where: and(eq(alerts.status, 'resolved'), gte(alerts.resolvedAt, new Date(ctx.now - 86_400_000))),
        orderBy: desc(alerts.resolvedAt),
        limit: LIST_MAX,
      })
    : (await db.query.alerts.findMany({ where: eq(alerts.status, 'firing'), orderBy: desc(alerts.startedAt), limit: 100 })).sort(
        (a, b) => (a.severity === b.severity ? b.startedAt.getTime() - a.startedAt.getTime() : a.severity === 'critical' ? -1 : 1),
      )
  const shown = rows.slice(0, LIST_MAX)
  const lines = [resolved ? `🕘 <b>Закрыты за сутки</b> · ${at(ctx)}` : `🚨 <b>Горящие алерты · ${rows.length}</b> · ${at(ctx)}`, '']
  if (!rows.length) lines.push(resolved ? 'За сутки алерты не закрывались.' : '✅ Горящих алертов нет.')
  for (const [n, a] of shown.entries()) {
    const state = a.status === 'resolved'
      ? `длился ${ago(a.startedAt.getTime(), a.resolvedAt?.getTime() ?? ctx.now)}`
      : [`горит ${ago(a.startedAt.getTime(), ctx.now)}`, a.acknowledgedBy ? `✋ ${a.acknowledgedBy}` : '', a.silencedUntil && a.silencedUntil.getTime() > ctx.now ? '🔕 тишина' : '']
          .filter(Boolean)
          .join(' · ')
    lines.push(`${a.status === 'firing' ? SEV(a.severity) : '🟢'} ${n + 1}. <b>${e(a.object)}</b> — ${e(a.title)}${a.value ? ` · ${e(a.value)}` : ''}`, `    <i>${e(state)}</i>`)
  }
  if (rows.length > LIST_MAX) lines.push('', `и ещё ${rows.length - LIST_MAX} — в консоли`)
  const rows2: Button[][] = shown.map((a, n) => [alertButton(a, n + 1)])
  rows2.push(resolved ? [cb('🚨 Горящие', 'm:al')] : [cb('🕘 Закрытые за сутки', 'm:ar')])
  rows2.push(navRow(['Меню', 'm:home'], resolved ? 'm:ar' : 'm:al'))
  return { html: fit(lines), rows: rows2 }
}

export async function alertView(ctx: ViewCtx, id: number): Promise<View | null> {
  const row = await getDb().query.alerts.findFirst({ where: eq(alerts.id, id) })
  if (!row) return null
  const firing = row.status === 'firing'
  const flapping = firing && (await isFlapping(row.fingerprint))
  const event = firing ? (flapping ? 'flapping' : 'firing') : row.resolvedBy ? 'closed' : 'resolved'
  const msg = await buildMessage(row, event, flapping ? { flapCount: await recentFires(row.fingerprint), now: ctx.now } : { now: ctx.now })
  const html = alertCardHtml(msg)
  const actions: Button[] = []
  if (firing && ctx.operator) {
    if (!row.acknowledgedBy) actions.push(cb('✋ Беру в работу', `m:aa:${id}`))
    if (!row.silencedUntil || row.silencedUntil.getTime() < ctx.now + 55 * 60_000) actions.push(cb('🔕 Тишина 1 ч', `m:am:${id}`))
  }
  const rows: Button[][] = [actions]
  // Ссылка в консоль уже в тексте карточки; кнопки — переходы внутри меню: инцидент и сервер.
  const host = await hostRowidForRoute(row.route)
  rows.push([...(row.incidentId ? [cb(`🔥 ${incidentCode(row.incidentId)}`, `m:i:${row.incidentId}`)] : []), ...(host ? [cb('🖥 Сервер', `m:h:${host}`)] : [])])
  rows.push(navRow([firing ? 'Алерты' : 'Закрытые', firing ? 'm:al' : 'm:ar'], `m:a:${id}`))
  return { html: fit(html.split('\n')), rows }
}

export async function incidentsView(ctx: ViewCtx): Promise<View> {
  const db = getDb()
  const [open, closed] = await Promise.all([
    db.query.incidents.findMany({ where: inArray(incidents.status, ['active', 'monitoring']), orderBy: desc(incidents.startedAt), limit: 50 }),
    db.query.incidents.findMany({
      where: and(eq(incidents.status, 'resolved'), gte(incidents.resolvedAt, new Date(ctx.now - 7 * 86_400_000))),
      orderBy: desc(incidents.resolvedAt),
      limit: 5,
    }),
  ])
  const lines = [`🔥 <b>Инциденты · открыто ${open.length}</b> · ${at(ctx)}`, '']
  if (!open.length) lines.push('✅ Открытых инцидентов нет.')
  for (const i of open.slice(0, LIST_MAX)) {
    lines.push(
      `${SEV(i.severity)} <b>${incidentCode(i.id)}</b> ${e(i.title)}`,
      `    <i>${i.status === 'monitoring' ? 'наблюдение' : 'активен'} · ${ago(i.startedAt.getTime(), ctx.now)} · ${e(i.assignee ?? 'не назначен')}</i>`,
    )
  }
  if (closed.length) {
    lines.push('', '<b>Закрыты за неделю</b>')
    for (const i of closed) lines.push(`🟢 ${incidentCode(i.id)} ${e(short(i.title, 60))} — ${ago(i.startedAt.getTime(), i.resolvedAt?.getTime() ?? ctx.now)}`)
  }
  const rows: Button[][] = [...open.slice(0, LIST_MAX), ...closed]
    .slice(0, LIST_MAX)
    .map((i) => [cb(`${i.status === 'resolved' ? '🟢' : SEV(i.severity)} ${incidentCode(i.id)} · ${short(i.title, 30)}`, `m:i:${i.id}`)])
  rows.push(navRow(['Меню', 'm:home'], 'm:in'))
  return { html: fit(lines), rows }
}

const EVENT_ICON: Record<string, string> = { opened: '🟥', alert: '🔔', note: '📝', status: '🔁', action: '✋', resolved: '✅' }

export async function incidentView(ctx: ViewCtx, id: number): Promise<View | null> {
  const db = getDb()
  const inc = await db.query.incidents.findFirst({ where: eq(incidents.id, id) })
  if (!inc) return null
  const [related, events] = await Promise.all([
    db.query.alerts.findMany({ where: eq(alerts.incidentId, id), orderBy: desc(alerts.startedAt), limit: 20 }),
    db.query.incidentEvents.findMany({ where: eq(incidentEvents.incidentId, id), orderBy: desc(incidentEvents.createdAt), limit: 6 }),
  ])
  const facts = await incidentFacts(inc, related.map((a) => a.id))
  const open = inc.status !== 'resolved'
  const end = inc.resolvedAt?.getTime() ?? ctx.now
  const lines = [
    `${open ? SEV(inc.severity) : '🟢'} <b>${incidentCode(inc.id)} · ${e(inc.title)}</b>`,
    `<i>${open ? (inc.status === 'monitoring' ? 'на наблюдении' : 'активен') : `закрыт${inc.closeResult ? ` — ${CLOSE_RESULT_LABEL[inc.closeResult]}` : ''}`} · начало ${e(clock(inc.startedAt.getTime(), ctx.tz, ctx.now, true))} · ${open ? 'идёт' : 'длился'} ${ago(inc.startedAt.getTime(), end)}</i>`,
    `Ответственный: <b>${e(inc.assignee ?? 'не назначен')}</b>`,
  ]
  // Автоматический инцидент кладёт в summary заголовок алерта — повторять его под заголовком незачем.
  if (inc.summary && !inc.title.startsWith(inc.summary)) lines.push(e(inc.summary))
  if (inc.closeComment) lines.push(`💬 ${e(inc.closeComment)}`)
  lines.push('', `<b>Затронуто</b> · ${plural(related.length, ['алерт', 'алерта', 'алертов'])}`)
  for (const a of related.slice(0, 6)) lines.push(`${a.status === 'firing' ? SEV(a.severity) : '🟢'} ${e(a.object)} — ${e(a.title)}${a.acknowledgedBy ? ` · ✋ ${e(a.acknowledgedBy)}` : ''}`)
  if (facts.length) {
    lines.push('', '<b>Рядом по времени</b>')
    for (const f of facts.slice(0, 4)) lines.push(`${f.kind === 'deploy' ? '🚀' : f.kind === 'restart' ? '🔁' : '📭'} ${e(f.text)}`)
  }
  if (events.length) {
    lines.push('', '<b>Последнее в хронологии</b>')
    for (const ev of [...events].reverse()) lines.push(`${EVENT_ICON[ev.kind] ?? '•'} ${e(clock(ev.createdAt.getTime(), ctx.tz, ctx.now))} ${e(short(ev.message, 140))}${ev.author !== 'system' ? ` — ${e(ev.author)}` : ''}`)
  }
  const unacked = related.some((a) => a.status === 'firing' && !a.acknowledgedBy)
  const rows: Button[][] = []
  if (open && ctx.operator && (unacked || !inc.assignee)) rows.push([cb(inc.assignee ? '✋ Взять алерты в работу' : '✋ Беру инцидент', `m:ia:${id}`)])
  const firingAlerts = related.filter((a) => a.status === 'firing').slice(0, 4)
  for (let i = 0; i < firingAlerts.length; i += 2) rows.push(firingAlerts.slice(i, i + 2).map((a) => alertButton(a)))
  rows.push(consoleButton(ctx, `/incidents/${id}`))
  rows.push(navRow(['Инциденты', 'm:in'], `m:i:${id}`))
  return { html: fit(lines), rows }
}


/** Ключ кнопки хоста по маршруту алерта «/infrastructure/<id>» — для кнопки «Сервер» в карточке. */
async function hostRowidForRoute(route: string): Promise<string | null> {
  const m = /^\/infrastructure\/([^/?#]+)/.exec(route)
  if (!m) return null
  let id: string
  try {
    id = decodeURIComponent(m[1]!)
  } catch {
    return null
  }
  const [row] = await getDb()
    .select({ rowid: sql<number>`${agents}.rowid` })
    .from(agents)
    .where(eq(agents.id, id))
    .limit(1)
  return row ? hostKey(row.rowid, id) : null
}
