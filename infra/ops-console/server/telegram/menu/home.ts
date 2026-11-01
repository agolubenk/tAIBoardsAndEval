/** Главный экран меню: что горит, и кнопки разделов со счётчиками. */
import { desc, eq, inArray } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { agents, alerts, containers, incidents, monitors } from '../../db/schema'
import { getGeneralSettings } from '../../settings/store'
import { agentUiStatus } from '../../routes/status'
import { activeWindows } from '../../maintenance/store'
import { overviewKpis } from '../../overview/kpis'
import { plural } from '../../../shared/plural'
import { incidentCode } from '../../../shared/codes'
import { clock } from '../../lib/time'
import { ago, at, cb, consoleButton, e, pairs, short, type View, type ViewCtx } from './ui'

export async function homeView(ctx: ViewCtx): Promise<View> {
  const db = getDb()
  const general = await getGeneralSettings()
  const [firing, open, mons, hosts, ctrRows, windows] = await Promise.all([
    db.query.alerts.findMany({ where: eq(alerts.status, 'firing'), orderBy: desc(alerts.startedAt), limit: 100 }),
    db.query.incidents.findMany({ where: inArray(incidents.status, ['active', 'monitoring']), orderBy: desc(incidents.startedAt), limit: 20 }),
    db.query.monitors.findMany({ where: eq(monitors.enabled, true), limit: 100 }),
    db.query.agents.findMany({ where: eq(agents.enabled, true), limit: 50 }),
    db
      .select({ state: containers.state, health: containers.health, restartPolicy: containers.restartPolicy, exitCode: containers.exitCode })
      .from(containers)
      .limit(2000),
    activeWindows(ctx.now),
  ])
  const kpis = await overviewKpis(ctrRows)
  const crit = firing.filter((a) => a.severity === 'critical').length
  const firingLite = firing.map((a) => ({ severity: a.severity, route: a.route }))
  const statuses = hosts.map((h) => agentUiStatus(h, firingLite, general.agentSilentAfterIntervals, ctx.now, windows.some((w) => w.scope === 'all' || (w.scope === 'agent' && w.target === h.id))))
  const silent = statuses.filter((s) => s === 'unknown' || s === 'pending').length
  const up = mons.filter((m) => m.lastOk).length
  const down = mons.filter((m) => m.lastOk === false).length
  const c = kpis.containers
  const containerIssues = c.restarting + c.unhealthy + c.stopped

  const unowned = firing.filter((a) => !a.acknowledgedBy).length
  const head = firing.length
    ? `${crit ? '🔴' : '🟠'} <b>Горит ${firing.length}</b>${crit ? ` · критичных ${crit}` : ''}${unowned ? ` · без ответственного ${unowned}` : ' · все в работе'}`
    : '🟢 <b>Всё в норме</b> — горящих алертов нет'
  // Что горит — сразу на главной: до карточки алерта одно нажатие.
  const top = [...firing].sort((a, b) => (a.severity === b.severity ? b.startedAt.getTime() - a.startedAt.getTime() : a.severity === 'critical' ? -1 : 1)).slice(0, 3)
  const lines = [`🏠 <b>${e(general.consoleName)}</b> · ${at(ctx)}`, '', head]
  top.forEach((a, i) => {
    lines.push(`${a.severity === 'critical' ? '🔴' : '🟠'} ${i + 1}. ${e(a.object)} — ${e(a.title)}${a.value ? `, ${e(a.value)}` : ''} · ${ago(a.startedAt.getTime(), ctx.now)}${a.acknowledgedBy ? ` · ✋ ${e(a.acknowledgedBy)}` : ''}`)
  })
  if (firing.length > top.length) lines.push(`и ещё ${firing.length - top.length} — «Алерты»`)
  if (open.length) lines.push(`🔥 Открыто: ${open.slice(0, 3).map((i) => incidentCode(i.id)).join(', ')}${open.length > 3 ? ` и ещё ${open.length - 3}` : ''}`)
  for (const w of windows.slice(0, 2)) lines.push(`🛠 Техработы до ${e(clock(w.endsAt.getTime(), ctx.tz, ctx.now))}: ${e(w.reason)}`)
  lines.push(
    '',
    `🌐 Проверки: <b>${up} из ${mons.length}</b>${down ? ` · недоступно ${down}` : mons.length ? ' · все отвечают' : ''}`,
    `🖥 Серверы: <b>${hosts.length - silent} на связи</b>${silent ? ` · молчит ${silent}` : ''}`,
    `📦 Контейнеры: <b>${c.running} / ${c.total}</b>${containerIssues ? ` · ${[c.restarting && `перезапускается ${c.restarting}`, c.unhealthy && `нездоровы ${c.unhealthy}`, c.stopped && `остановлено ${c.stopped}`].filter(Boolean).join(', ')}` : ''}`,
  )
  const tls = kpis.tls.nearest
  if (tls) lines.push(`🔒 TLS: ${tls.error ? `ошибка ${e(tls.domain)}` : `ближайший ${e(tls.domain)} — ${plural(tls.daysLeft ?? 0, ['день', 'дня', 'дней'])}`}`)
  if (kpis.notifications.failing.length) lines.push(`📭 Не доставляется: ${e(kpis.notifications.failing.map((f) => f.name).join(', '))}`)

  const rows = top.map((a, i) => [cb(`${a.severity === 'critical' ? '🔴' : '🟠'} ${i + 1} · ${short(a.object, 30)}`, `m:a:${a.id}`)])
  rows.push(...pairs([
    cb(`🚨 Алерты${firing.length ? ` · ${firing.length}` : ''}`, 'm:al'),
    cb(`🔥 Инциденты${open.length ? ` · ${open.length}` : ''}`, 'm:in'),
    cb(`🖥 Серверы · ${hosts.length}`, 'm:hs'),
    cb(`🌐 Проверки · ${mons.length}`, 'm:ms'),
    cb('🚀 Деплои', 'm:dp'),
    cb('🔒 TLS', 'm:tl'),
    cb('⚡ Срочный отчёт', 'rep:now'),
    cb('📈 Графики', 'rep:charts'),
  ]))
  rows.push([cb('🔄 Обновить', 'm:home'), ...consoleButton(ctx, '/')])
  return { html: lines.join('\n'), rows }
}
