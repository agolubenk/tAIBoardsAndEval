/**
 * Меню: контейнеры хоста (список с кнопками) и карточка контейнера — состояние, память, healthcheck,
 * последний ручной перезапуск и «Перезапустить» (оператор, только в личке: причину и, у контейнера с
 * данными, имя бот спрашивает сообщениями — server/telegram/restart.ts). Одна кнопка — один контейнер.
 */
import { createHash } from 'node:crypto'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { agents, commands, containers } from '../../db/schema'
import { isContainerDown } from '../../alerts/container-state'
import { recentRestarts } from '../../agents/restarts'
import { hostByKey, hostKey } from './infra'
import { ago, at, cb, consoleButton, e, fit, navRow, pairs, short, type Button, type View, type ViewCtx } from './ui'

type ContainerRow = typeof containers.$inferSelect
type CommandStatus = (typeof commands.$inferSelect)['status']

const LIST_MAX = 40

/** Ключ контейнера в callback_data (регулярное выражение, без якорей). */
export const CONTAINER_KEY = '(\\d{1,9}x[0-9a-f]{6})'

/**
 * Ключ контейнера в кнопке: rowid + 6 hex sha1 от «агент + имя» — имя бывает длиннее лимита
 * callback_data (64 байта). rowid переиспользуется после удаления строки — без хвоста старая кнопка
 * открыла бы другой контейнер. Отчёт агента обновляет строку upsert'ом, rowid при этом не меняется.
 */
export function containerKey(rowid: number, agentId: string, name: string): string {
  return `${rowid}x${createHash('sha1').update(`${agentId}\n${name}`).digest('hex').slice(0, 6)}`
}

const ctrRowid = sql<number>`${containers}.rowid`

/** Контейнер по ключу кнопки; null — нет или ключ от удалённого контейнера. */
export async function containerByKey(key: string): Promise<ContainerRow | null> {
  const m = /^(\d{1,9})x[0-9a-f]{6}$/.exec(key)
  if (!m) return null
  const [row] = await getDb()
    .select({ rowid: ctrRowid, ctr: containers })
    .from(containers)
    .where(sql`${containers}.rowid = ${Number(m[1])}`)
    .limit(1)
  return row && containerKey(row.rowid, row.ctr.agentId, row.ctr.name) === key ? row.ctr : null
}

/** Ключ кнопки по агенту и имени (ответ бота после перезапуска ведёт в карточку). */
export async function containerKeyFor(agentId: string, name: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ rowid: ctrRowid })
    .from(containers)
    .where(and(eq(containers.agentId, agentId), eq(containers.name, name)))
    .limit(1)
  return row ? containerKey(row.rowid, agentId, name) : null
}

const problemOf = (c: ContainerRow, loops: Record<string, number>) => isContainerDown(c) || c.health === 'unhealthy' || Boolean(loops[c.name])
const iconOf = (c: ContainerRow, loops: Record<string, number>) => (problemOf(c, loops) ? '🔴' : c.state === 'running' ? '🟢' : '⚪️')

export async function containersView(ctx: ViewCtx, key: string): Promise<View | null> {
  const host = await hostByKey(key)
  if (!host) return null
  const rows = await getDb()
    .select({ rowid: ctrRowid, ctr: containers })
    .from(containers)
    .where(eq(containers.agentId, host.agent.id))
    .orderBy(asc(containers.name))
    .limit(250)
  const loops = await recentRestarts(
    host.agent.id,
    rows.map((r) => r.ctr),
  )
  const sorted = [...rows].sort((a, b) => Number(problemOf(b.ctr, loops)) - Number(problemOf(a.ctr, loops)) || a.ctr.name.localeCompare(b.ctr.name))
  const lines = [`📦 <b>Контейнеры · ${e(host.agent.name)}</b> · ${at(ctx)}`, '']
  if (!rows.length) lines.push('Агент не видит контейнеров.')
  for (const { ctr: c } of sorted.slice(0, LIST_MAX)) {
    const mem = c.memMb !== null ? `${Math.round(c.memMb)}${c.memLimitMb ? `/${Math.round(c.memLimitMb)}` : ''} МБ` : ''
    const extra = [c.state !== 'running' ? c.state : '', c.health === 'unhealthy' ? 'unhealthy' : '', loops[c.name] ? `⟳ ${loops[c.name]} за 10 мин` : '', mem]
      .filter(Boolean)
      .join(' · ')
    lines.push(`${iconOf(c, loops)} ${e(c.name)}${extra ? ` — ${e(extra)}` : ''}`)
  }
  if (sorted.length > LIST_MAX) lines.push(`и ещё ${sorted.length - LIST_MAX} — в консоли`)
  const buttons = sorted.slice(0, LIST_MAX).map((r) => cb(`${iconOf(r.ctr, loops)} ${short(r.ctr.name, 28)}`, `m:k:${containerKey(r.rowid, r.ctr.agentId, r.ctr.name)}`))
  return {
    html: fit(lines),
    rows: [
      ...pairs(buttons),
      consoleButton(ctx, `/infrastructure/${encodeURIComponent(host.agent.id)}?tab=containers`),
      navRow([short(host.agent.name, 18), `m:h:${key}`], `m:hc:${key}`),
    ],
  }
}

const STATE_LABEL: Record<string, string> = {
  running: 'работает',
  exited: 'остановлен',
  restarting: 'перезапускается',
  paused: 'на паузе',
  dead: 'не запускается',
  created: 'создан, не запущен',
}

const COMMAND_LABEL: Record<CommandStatus, string> = {
  pending: '⏳ в очереди — агент заберёт команду со следующим отчётом',
  claimed: '🔄 выполняется на сервере',
  succeeded: '✅ выполнен',
  failed: '❌ ошибка',
  expired: '⌛ истёк — агент не ответил за 10 минут',
}

/** Карточка контейнера: что с ним сейчас и чем кончился последний ручной перезапуск. */
export async function containerView(ctx: ViewCtx, key: string): Promise<View | null> {
  const c = await containerByKey(key)
  if (!c) return null
  const db = getDb()
  const [[host], last, loops] = await Promise.all([
    db
      .select({ rowid: sql<number>`${agents}.rowid`, agent: agents })
      .from(agents)
      .where(eq(agents.id, c.agentId))
      .limit(1),
    db.query.commands.findFirst({ where: and(eq(commands.agentId, c.agentId), eq(commands.target, c.name)), orderBy: desc(commands.requestedAt) }),
    recentRestarts(c.agentId, [c]),
  ])
  if (!host) return null
  const lines = [
    `${iconOf(c, loops)} <b>${e(c.name)}</b> — ${e(STATE_LABEL[c.state] ?? c.state)}${c.health !== 'none' ? ` · ${e(c.health)}` : ''} · ${at(ctx)}`,
    `<i>${e(host.agent.name)}${c.image ? ` · ${e(short(c.image, 60))}` : ''}${c.composeService ? ` · сервис ${e(c.composeService)}` : ''}</i>`,
    '',
  ]
  const facts = [
    c.startedAt && c.state === 'running' ? `запущен ${ago(c.startedAt.getTime(), ctx.now)} назад` : '',
    c.state === 'exited' && c.exitCode !== null ? `код выхода ${c.exitCode}` : '',
    loops[c.name] ? `перезапусков за 10 мин: ${loops[c.name]}` : '',
    c.memMb !== null ? `память ${Math.round(c.memMb)}${c.memLimitMb ? ` из ${Math.round(c.memLimitMb)}` : ''} МБ` : '',
    c.cpuPct !== null ? `CPU ${Math.round(c.cpuPct)}%` : '',
  ].filter(Boolean)
  if (facts.length) lines.push(e(facts.join(' · ')))
  if (c.health === 'unhealthy' && c.healthLog) lines.push(`🩺 Healthcheck: <code>${e(short(c.healthLog, 300))}</code>`)
  if (c.stateful) lines.push('🗄 Хранит данные — перезапуск только с вводом имени контейнера.')
  if (last) {
    lines.push(
      '',
      `<b>Последний ручной перезапуск</b> · ${ago(last.requestedAt.getTime(), ctx.now)} назад, ${e(last.requestedBy)}`,
      COMMAND_LABEL[last.status],
      `<i>Причина: ${e(short(last.reason, 200))}</i>`,
    )
    if ((last.status === 'failed' || last.status === 'expired') && last.output) lines.push(`<code>${e(short(last.output, 200))}</code>`)
  }
  const busy = last?.status === 'pending' || last?.status === 'claimed'
  const rows: Button[][] = []
  if (ctx.restart && !busy) rows.push([cb('🔁 Перезапустить', `m:kr:${key}`)])
  rows.push(consoleButton(ctx, `/infrastructure/${encodeURIComponent(c.agentId)}?tab=containers`))
  rows.push(navRow(['Контейнеры', `m:hc:${hostKey(host.rowid, host.agent.id)}`], `m:k:${key}`))
  return { html: fit(lines), rows }
}
