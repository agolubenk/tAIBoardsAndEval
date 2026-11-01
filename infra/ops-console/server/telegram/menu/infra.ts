/** Меню: серверы (карточка; контейнеры — menu/container.ts), внешние проверки (карточка, «Проверить сейчас»), деплои, TLS. */
import { createHash } from 'node:crypto'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { agents, alerts, containers, deploys, monitors, tlsChecks } from '../../db/schema'
import { getGeneralSettings, readSetting } from '../../settings/store'
import { agentUiStatus, type UiStatus } from '../../routes/status'
import { activeWindows, windowFor } from '../../maintenance/store'
import { isContainerDown } from '../../alerts/container-state'
import { recentRestarts } from '../../agents/restarts'
import { latencyStats, monitorDetailStats } from '../../monitors/stats'
import { monitorUptime } from '../../monitors/uptime'
import { incidentsAfterDeploys } from '../../incidents/facts'
import { deploySyncSchema } from '../../deploys/github'
import { clock } from '../../lib/time'
import { plural } from '../../../shared/plural'
import { incidentCode } from '../../../shared/codes'
import { ago, at, cb, consoleButton, e, fit, ms, navRow, pct, short, STATUS_ICON, STATUS_LABEL, type Button, type View, type ViewCtx } from './ui'

interface Snap {
  hostname?: string
  os?: string
  osName?: string
  agentVersion?: string
  uptimeSec?: number
  cpu?: { pct?: number; load1?: number; cores?: number }
  memory?: { totalMb?: number; usedMb?: number; swapTotalMb?: number; swapUsedMb?: number }
  disks?: Array<{ mount: string; totalGb: number; usedGb: number; inodePct?: number }>
  network?: { rxBytesPerSec?: number; txBytesPerSec?: number; errors?: number }
  dockerError?: string
}

const gb = (mb: number) => `${(mb / 1024).toFixed(1).replace(/\.0$/, '')} ГБ`
const mbs = (b: number | undefined) => (b === undefined ? '—' : b >= 1_048_576 ? `${(b / 1_048_576).toFixed(1)} МБ/с` : `${Math.round(b / 1024)} КБ/с`)

function metrics(snap: Snap | null) {
  const mem = snap?.memory?.totalMb && snap.memory.usedMb !== undefined ? (snap.memory.usedMb / snap.memory.totalMb) * 100 : null
  const disks = (snap?.disks ?? []).filter((d) => d.totalGb > 0)
  const worst = disks.reduce<(typeof disks)[number] | null>((acc, d) => (!acc || d.usedGb / d.totalGb > acc.usedGb / acc.totalGb ? d : acc), null)
  return { cpu: snap?.cpu?.pct ?? null, mem, disk: worst ? { ...worst, pct: (worst.usedGb / worst.totalGb) * 100 } : null }
}

const parseSnap = (json: string | null): Snap | null => {
  if (!json) return null
  try {
    return JSON.parse(json) as Snap
  } catch {
    return null
  }
}

/**
 * Ключ хоста в кнопке: rowid (короткий — id агента бывает до 64 символов) + 4 hex sha1 от id.
 * rowid у таблицы с текстовым ключом переиспользуется после удаления — без хвоста старая кнопка
 * открыла бы другой сервер.
 */
export function hostKey(rowid: number, id: string): string {
  return `${rowid}x${createHash('sha1').update(id).digest('hex').slice(0, 4)}`
}

/** Агент по ключу кнопки; null — нет или ключ от удалённого сервера. */
export async function hostByKey(key: string): Promise<{ rowid: number; agent: typeof agents.$inferSelect } | null> {
  const m = /^(\d{1,9})x([0-9a-f]{4})$/.exec(key)
  if (!m) return null
  const [row] = await hostRows(sql`${agents}.rowid = ${Number(m[1])}`)
  return row && hostKey(row.rowid, row.agent.id) === key ? row : null
}

/** Хосты с rowid — короткий числовой ключ для callback_data (id агента бывает до 64 символов). */
async function hostRows(where?: ReturnType<typeof sql>) {
  return getDb()
    .select({ rowid: sql<number>`${agents}.rowid`, agent: agents })
    .from(agents)
    .where(where ?? eq(agents.enabled, true))
    .orderBy(asc(agents.name))
    .limit(50)
}

async function statusOf(list: Array<typeof agents.$inferSelect>, now: number): Promise<Map<string, UiStatus>> {
  const general = await getGeneralSettings()
  const [firing, windows] = await Promise.all([
    getDb().select({ severity: alerts.severity, route: alerts.route }).from(alerts).where(eq(alerts.status, 'firing')).limit(500),
    activeWindows(now),
  ])
  return new Map(list.map((a) => [a.id, agentUiStatus(a, firing, general.agentSilentAfterIntervals, now, Boolean(windowFor(windows, 'agent', a.id)))]))
}

const RANK: Record<UiStatus, number> = { critical: 0, warning: 1, unknown: 2, pending: 3, maintenance: 4, healthy: 5 }

export async function hostsView(ctx: ViewCtx): Promise<View> {
  const rows = await hostRows()
  const status = await statusOf(
    rows.map((r) => r.agent),
    ctx.now,
  )
  rows.sort((a, b) => RANK[status.get(a.agent.id) ?? 'unknown'] - RANK[status.get(b.agent.id) ?? 'unknown'] || a.agent.name.localeCompare(b.agent.name))
  const lines = [`🖥 <b>Серверы · ${rows.length}</b> · ${at(ctx)}`, '']
  if (!rows.length) lines.push('Серверы не подключены: «Настройки → Агенты» в консоли.')
  for (const r of rows.slice(0, 12)) {
    const st = status.get(r.agent.id) ?? 'unknown'
    const m = metrics(parseSnap(r.agent.lastSnapshotJson))
    lines.push(
      `${STATUS_ICON[st]} <b>${e(r.agent.name)}</b> — ${STATUS_LABEL[st]}`,
      `    <i>CPU ${pct(m.cpu)} · RAM ${pct(m.mem)} · диск ${pct(m.disk?.pct ?? null)} · отчёт ${r.agent.lastSeenAt ? `${ago(r.agent.lastSeenAt.getTime(), ctx.now)} назад` : 'не было'}</i>`,
    )
  }
  if (rows.length > 12) lines.push('', `и ещё ${rows.length - 12} — в консоли`)
  const buttons: Button[][] = rows.slice(0, 12).map((r) => [cb(`${STATUS_ICON[status.get(r.agent.id) ?? 'unknown']} ${short(r.agent.name, 34)}`, `m:h:${hostKey(r.rowid, r.agent.id)}`)])
  buttons.push(navRow(['Меню', 'm:home'], 'm:hs'))
  return { html: fit(lines), rows: buttons }
}

export async function hostView(ctx: ViewCtx, key: string): Promise<View | null> {
  const row = await hostByKey(key)
  if (!row) return null
  const a = row.agent
  const snap = parseSnap(a.lastSnapshotJson)
  const m = metrics(snap)
  const status = (await statusOf([a], ctx.now)).get(a.id) ?? 'unknown'
  const db = getDb()
  const route = `/infrastructure/${encodeURIComponent(a.id)}`
  const [ctrs, firing, windows] = await Promise.all([
    db.query.containers.findMany({ where: eq(containers.agentId, a.id), orderBy: asc(containers.name), limit: 250 }),
    db.query.alerts.findMany({ where: and(eq(alerts.status, 'firing'), eq(alerts.route, route)), orderBy: desc(alerts.startedAt), limit: 20 }),
    activeWindows(ctx.now),
  ])
  const loops = await recentRestarts(a.id, ctrs)
  const win = windowFor(windows, 'agent', a.id)
  const bad = ctrs.filter((c) => isContainerDown(c) || c.health === 'unhealthy' || loops[c.name])
  const spec = [snap?.osName || snap?.os, snap?.cpu?.cores ? `${snap.cpu.cores} vCPU` : '', snap?.memory?.totalMb ? gb(snap.memory.totalMb) : ''].filter(Boolean).join(' · ')
  const lines = [
    `${STATUS_ICON[status]} <b>${e(a.name)}</b> — ${STATUS_LABEL[status]}`,
    `<i>${e(a.environment)}${spec ? ` · ${e(spec)}` : ''} · ${a.lastSeenAt ? `${status === 'unknown' ? 'молчит, последний отчёт' : 'отчёт'} ${ago(a.lastSeenAt.getTime(), ctx.now)} назад` : 'отчётов ещё не было'}</i>`,
  ]
  if (win) lines.push(`🛠 Техработы до ${e(clock(win.endsAt.getTime(), ctx.tz, ctx.now))}: ${e(win.reason)}`)
  if (snap?.dockerError) lines.push(`⚠️ Docker недоступен агенту: ${e(snap.dockerError)}`)
  lines.push(
    '',
    `CPU <b>${pct(m.cpu)}</b>${snap?.cpu?.load1 !== undefined ? ` · load ${snap.cpu.load1}` : ''}`,
    `RAM <b>${pct(m.mem)}</b>${snap?.memory?.totalMb && snap.memory.usedMb !== undefined ? ` · ${gb(snap.memory.usedMb)} из ${gb(snap.memory.totalMb)}` : ''}${snap?.memory?.swapTotalMb ? ` · swap ${gb(snap.memory.swapUsedMb ?? 0)}` : ''}`,
    `Диск <b>${pct(m.disk?.pct ?? null)}</b>${m.disk ? ` · ${e(m.disk.mount)} свободно ${(m.disk.totalGb - m.disk.usedGb).toFixed(1)} ГБ${m.disk.inodePct !== undefined ? ` · иноды ${pct(m.disk.inodePct)}` : ''}` : ''}`,
    `Сеть ↓ ${mbs(snap?.network?.rxBytesPerSec)} ↑ ${mbs(snap?.network?.txBytesPerSec)}${snap?.network?.errors ? ` · ошибок ${snap.network.errors}` : ''}`,
    '',
    `📦 Контейнеры: <b>${ctrs.filter((c) => c.state === 'running').length} из ${ctrs.length}</b> работают${bad.length ? ` · с проблемами ${bad.length}` : ''}`,
  )
  for (const c of bad.slice(0, 6)) {
    lines.push(`🔴 ${e(c.name)} — ${e(c.state)}${c.health === 'unhealthy' ? ', unhealthy' : ''}${loops[c.name] ? `, перезапусков за 10 мин: ${loops[c.name]}` : ''}${c.exitCode !== null && c.state === 'exited' ? `, код ${c.exitCode}` : ''}`)
  }
  if (firing.length) {
    lines.push('', `🚨 <b>Горит на сервере · ${firing.length}</b>`)
    for (const f of firing.slice(0, 5)) lines.push(`${f.severity === 'critical' ? '🔴' : '🟠'} ${e(f.title)}${f.value ? ` — ${e(f.value)}` : ''}`)
  }
  const rows: Button[][] = [
    [cb(`📦 Контейнеры · ${ctrs.length}`, `m:hc:${key}`), cb('📈 Графики хоста', `m:hg:${key}`)],
    ...firing.slice(0, 4).map((f) => [cb(`${f.severity === 'critical' ? '🔴' : '🟠'} ${short(f.title, 34)}`, `m:a:${f.id}`)]),
    consoleButton(ctx, route),
    navRow(['Серверы', 'm:hs'], `m:h:${key}`),
  ]
  return { html: fit(lines), rows }
}

type MonitorRow = typeof monitors.$inferSelect

/** Доступность по сырым проверкам окна (успешные / все), если часовых агрегатов ещё нет. */
function rawUptime(stats: { latency: { samples: number }; failures: unknown[] }): number | null {
  const total = stats.latency.samples + stats.failures.length
  return total ? (stats.latency.samples / total) * 100 : null
}
const monStatus = (m: MonitorRow): UiStatus => (!m.enabled ? 'unknown' : m.lastOk === null ? 'pending' : m.lastOk ? 'healthy' : 'critical')

export async function monitorsView(ctx: ViewCtx): Promise<View> {
  const list = await getDb().query.monitors.findMany({ where: eq(monitors.enabled, true), orderBy: [monitors.sortOrder, monitors.id], limit: 30 })
  const [lat, up] = await Promise.all([latencyStats(list.map((m) => m.id), ctx.now - 86_400_000, { cache: true }), monitorUptime(list.map((m) => m.id))])
  const sorted = [...list].sort((a, b) => RANK[monStatus(a)] - RANK[monStatus(b)])
  const lines = [`🌐 <b>Проверки · ${list.length}</b> · ${at(ctx)}`, '']
  if (!list.length) lines.push('Проверок нет — добавьте в консоли: «Мониторинг».')
  for (const m of sorted.slice(0, 12)) {
    const st = monStatus(m)
    lines.push(
      `${STATUS_ICON[st]} <b>${e(m.name)}</b> <i>${m.type.toUpperCase()}</i>`,
      `    <i>${pct(up.last24h.get(m.id)?.pct ?? null, 2)} за 24 ч · p95 ${ms(lat.get(m.id)?.p95)}${m.lastOk === false && m.lastError ? ` · ${e(short(m.lastError, 60))}` : ''}</i>`,
    )
  }
  if (sorted.length > 12) lines.push('', `и ещё ${sorted.length - 12} — в консоли`)
  const rows: Button[][] = sorted.slice(0, 12).map((m) => [cb(`${STATUS_ICON[monStatus(m)]} ${short(m.name, 34)}`, `m:c:${m.id}`)])
  rows.push(navRow(['Меню', 'm:home'], 'm:ms'))
  return { html: fit(lines), rows }
}

export async function monitorView(ctx: ViewCtx, id: number): Promise<View | null> {
  const m = await getDb().query.monitors.findFirst({ where: eq(monitors.id, id) })
  if (!m) return null
  const [stats, up, windows] = await Promise.all([monitorDetailStats(id, ctx.now - 86_400_000), monitorUptime([id]), activeWindows(ctx.now)])
  const st = monStatus(m)
  const win = windowFor(windows, 'monitor', String(id))
  const target = m.type === 'dns' ? `${m.dnsRecord} ${m.url}` : m.url
  const days = up.daily.get(id) ?? []
  const measured = days.filter((d) => d.pct !== null)
  const pct30 = measured.length ? measured.reduce((s, d) => s + (d.pct ?? 0), 0) / measured.length : null
  const lines = [
    `${STATUS_ICON[win ? 'maintenance' : st]} <b>${e(m.name)}</b> — ${m.lastOk === null ? 'ждёт проверки' : m.lastOk ? 'доступен' : 'недоступен'}`,
    `<i>${m.type.toUpperCase()} · ${e(target)}</i>`,
    `Последняя проверка ${m.lastCheckedAt ? `${ago(m.lastCheckedAt.getTime(), ctx.now)} назад` : '—'}${m.lastStatusCode ? ` · HTTP ${m.lastStatusCode}` : ''}${m.lastLatencyMs !== null ? ` · ${ms(m.lastLatencyMs)}` : ''}`,
  ]
  if (m.lastOk === false && m.lastError) lines.push(`❌ ${e(m.lastError)}`)
  if (win) lines.push(`🛠 Техработы до ${e(clock(win.endsAt.getTime(), ctx.tz, ctx.now))}: ${e(win.reason)}`)
  lines.push(
    '',
    // Часовые агрегаты появляются с первым полным часом — до тех пор считаем по сырым проверкам.
    `Доступность: <b>${pct(up.last24h.get(id)?.pct ?? rawUptime(stats), 2)}</b> за 24 ч · ${pct(pct30, 2)} за 30 дней`,
    `Задержка успешных (24 ч): p50 <b>${ms(stats.latency.p50)}</b> · p95 <b>${ms(stats.latency.p95)}</b> · p99 ${ms(stats.latency.p99)}`,
  )
  if (m.type !== 'dns' && (stats.phases.connectMs !== null || stats.phases.ttfbMs !== null)) {
    lines.push(`Фазы: DNS ${ms(stats.phases.dnsMs)} · соединение ${ms(stats.phases.connectMs)} · TLS ${ms(stats.phases.tlsMs)} · первый байт ${ms(stats.phases.ttfbMs)}`)
  }
  lines.push('', stats.errors.length ? `<b>Ошибки за 24 ч · ${stats.failures.length}</b>` : '✅ Ошибок за 24 ч не было')
  for (const er of stats.errors.slice(0, 4)) lines.push(`• ${er.count} × ${e(short(er.error, 90))} — последняя ${ago(er.lastAt, ctx.now)} назад`)
  const rows: Button[][] = []
  if (ctx.operator) rows.push([cb('🔁 Проверить сейчас', `m:cc:${id}`)])
  rows.push(consoleButton(ctx, `/monitoring?monitor=${id}`))
  rows.push(navRow(['Проверки', 'm:ms'], `m:c:${id}`))
  return { html: fit(lines), rows }
}

export async function deploysView(ctx: ViewCtx): Promise<View> {
  const rows = await getDb().query.deploys.findMany({ orderBy: desc(deploys.createdAt), limit: 8 })
  const [linked, sync] = await Promise.all([incidentsAfterDeploys(rows), readSetting('deploy_sync', deploySyncSchema)])
  const lines = [`🚀 <b>Деплои</b> · ${at(ctx)}`]
  lines.push(sync.at ? `<i>синхронизация с GitHub ${ago(sync.at, ctx.now)} назад${sync.ok ? '' : ` — ошибка: ${e(short(sync.error, 80))}`}</i>` : '<i>GitHub ещё не опрашивался</i>', '')
  if (!rows.length) lines.push('Деплоев пока нет.')
  for (const d of rows) {
    const icon = d.status !== 'completed' ? '⏳' : d.conclusion === 'success' ? '🟢' : d.conclusion === 'failure' || d.conclusion === 'timed_out' || d.conclusion === 'not_started' ? '🔴' : '⚪️'
    const when = d.finishedAt ?? d.startedAt ?? d.createdAt
    const dur = d.startedAt && d.finishedAt ? ` · ${ago(d.startedAt.getTime(), d.finishedAt.getTime())}` : ''
    const inc = linked.get(d.id)
    lines.push(`${icon} ${e(clock(when.getTime(), ctx.tz, ctx.now))} ${e(short(d.title || d.workflow, 70))}${dur}${inc ? ` · ⚠️ ${incidentCode(inc.incidentId)} через ${inc.afterMin} мин` : ''}`)
  }
  const incButtons = [...new Set([...linked.values()].map((x) => x.incidentId))].slice(0, 3).map((iid) => cb(`🔥 ${incidentCode(iid)}`, `m:i:${iid}`))
  return { html: fit(lines), rows: [incButtons, consoleButton(ctx, '/deploys'), navRow(['Меню', 'm:home'], 'm:dp')] }
}

export async function tlsView(ctx: ViewCtx): Promise<View> {
  const rows = await getDb().query.tlsChecks.findMany({ orderBy: asc(tlsChecks.daysLeft), limit: 30 })
  const lines = [`🔒 <b>Сертификаты TLS · ${rows.length}</b> · ${at(ctx)}`, '']
  if (!rows.length) lines.push('Доменов нет: TLS проверяется у https-проверок.')
  for (const t of rows) {
    const icon = t.error ? '🔴' : t.daysLeft !== null && t.daysLeft < 7 ? '🔴' : t.daysLeft !== null && t.daysLeft < 21 ? '🟠' : '🟢'
    lines.push(
      `${icon} <b>${e(t.domain)}</b> — ${t.error ? `ошибка: ${e(short(t.error, 80))}` : `${plural(t.daysLeft ?? 0, ['день', 'дня', 'дней'])}${t.validTo ? ` (до ${e(clock(t.validTo.getTime(), ctx.tz, ctx.now))})` : ''}`}`,
    )
  }
  return { html: fit(lines), rows: [consoleButton(ctx, '/monitoring?tab=tls'), navRow(['Меню', 'm:home'], 'm:tl')] }
}
