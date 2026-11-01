/**
 * Детали монитора: статус, задержка успешных проверок (p50/p95/p99) отдельно от ошибок — сбои
 * метками на графике и разбивкой по причинам; фазы запроса (DNS, соединение, TLS, первый байт).
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { useAction } from '../../lib/hooks'
import { dateTime, fullDateTime, timeAgo } from '../../lib/format'
import type { CheckRow, Monitor, MonitorDetailStats } from '../../lib/types'
import { StatusBadge } from '../../ui/Badge'
import { Button } from '../../ui/Controls'
import { TimeSeriesChart } from '../../ui/Charts'
import { LoadError, Panel, Skeleton } from '../../ui/Glass'
import ui from '../../ui/styles'
import s from '../pages.module.css'
import { monitorLabel, monitorStatus, msFmt } from '../Monitoring'
import { MaintenanceDialog } from '../maintenance/MaintenanceDialog'

interface MonitorDetail {
  monitor: Monitor
  stats: MonitorDetailStats
  recent: CheckRow[]
  hourly: Array<{ t: number; total: number; ok: number; avgMs: number | null }>
}

/** Полоска фаз запроса: доли DNS / соединение / TLS / до первого байта. */
function PhaseBar({ phases }: { phases: MonitorDetailStats['phases'] }) {
  const parts: Array<[string, number | null, string]> = [
    ['DNS', phases.dnsMs, s.phaseDns ?? ''],
    ['Соединение', phases.connectMs, s.phaseConnect ?? ''],
    ['TLS', phases.tlsMs, s.phaseTls ?? ''],
    ['Первый байт', phases.ttfbMs, s.phaseTtfb ?? ''],
  ]
  const total = parts.reduce((sum, [, v]) => sum + (v ?? 0), 0)
  if (!total) return <p className={ui.muted}>Фазы ещё не измерены — появятся после следующих проверок.</p>
  return (
    <div className={ui.stack} style={{ gap: 6 }}>
      <div className={s.phaseBar} role="img" aria-label={parts.map(([l, v]) => `${l} ${msFmt(v)}`).join(', ')}>
        {parts.map(([label, v, cls]) => (v ? <span key={label} className={cls} style={{ flexGrow: v }} title={`${label}: ${msFmt(v)}`} /> : null))}
      </div>
      <div className={s.phaseLegend}>
        {parts.map(([label, v, cls]) => (
          <span key={label}>
            <i className={cls} /> {label} <b>{msFmt(v)}</b>
          </span>
        ))}
      </div>
    </div>
  )
}

export function MonitorDetailPanel({ id, onEdit }: { id: number; onEdit: (m: Monitor) => void }) {
  const { can } = useSession()
  const [maint, setMaint] = useState(false)
  const q = useQuery({
    queryKey: ['monitor', id],
    queryFn: () => api.get<MonitorDetail>(`/monitors/${id}?hours=24`),
    refetchInterval: 30_000,
  })
  const check = useAction(() => api.post<{ ok: boolean; error: string | null; latencyMs: number }>(`/monitors/${id}/check`), {
    success: (r) => (r.ok ? `Доступен, ${r.latencyMs} мс` : `Сбой: ${r.error}`),
    invalidate: [['monitor', id], ['monitors']],
  })
  const remove = useAction(() => api.del(`/monitors/${id}`), { success: 'Монитор удалён', invalidate: [['monitors'], ['overview']] })
  const endMaint = useAction((wid: number) => api.post(`/maintenance/${wid}/end`), {
    success: 'Техработы завершены',
    invalidate: [['monitor', id], ['monitors'], ['maintenance']],
  })
  if (q.isError) return <LoadError error={q.error} />
  if (!q.data) return <Skeleton height={260} />
  const { monitor: m, recent, hourly, stats } = q.data
  const hourlyPoints = hourly.filter((h) => h.avgMs !== null).map((h) => [h.t, h.avgMs as number] as [number, number])
  // Свежие проверки подробнее часовых агрегатов: за сутки по ним видно и всплески, и сбои.
  const recentOk = recent
    .filter((r) => r.ok && r.latencyMs !== null)
    .map((r) => [r.createdAt, r.latencyMs as number] as [number, number])
    .reverse()
  const byHour = recentOk.length < 10 && hourlyPoints.length >= 2
  const latency = byHour ? hourlyPoints : recentOk
  const failed = stats.failures.length
  const http = m.type === 'http'

  return (
    <Panel
      title={m.name}
      hint={`${m.type.toUpperCase()} · ${m.type === 'dns' ? `${m.dnsRecord} ${m.url}` : m.url}`}
      action={
        can('operator') ? (
          <div className={ui.row}>
            <Button small icon="refresh" busy={check.isPending} onClick={() => check.mutate(undefined)}>
              Проверить
            </Button>
            {m.maintenance ? (
              <Button small icon="wrench" busy={endMaint.isPending} onClick={() => endMaint.mutate(m.maintenance!.id)}>
                Завершить техработы
              </Button>
            ) : (
              <Button small icon="wrench" onClick={() => setMaint(true)}>
                Техработы
              </Button>
            )}
            <Button small onClick={() => onEdit(m)}>
              Изменить
            </Button>
            <Button
              small
              variant="ghost"
              onClick={() => {
                if (window.confirm(`Удалить монитор «${m.name}» вместе с историей?`)) remove.mutate(undefined)
              }}
            >
              Удалить
            </Button>
          </div>
        ) : null
      }
    >
      <div className={ui.stack}>
        <div className={ui.row}>
          <StatusBadge status={monitorStatus(m)} label={monitorLabel(m)} />
          <span className={ui.small}>
            Последняя проверка {timeAgo(m.lastCheckedAt)}
            {m.lastStatusCode ? ` · HTTP ${m.lastStatusCode}` : ''}
            {m.lastLatencyMs !== null ? ` · ${m.lastLatencyMs} мс` : ''}
          </span>
        </div>
        {m.maintenance ? (
          <div className={s.maintBanner}>
            🛠 Техработы до {fullDateTime(m.maintenance.endsAt)} — {m.maintenance.reason}
          </div>
        ) : null}
        {m.lastError ? <div className={ui.formError}>{m.lastError}</div> : null}

        <div className={s.grid4}>
          {(
            [
              ['p50', stats.latency.p50],
              ['p95', stats.latency.p95],
              ['p99', stats.latency.p99],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className={`${ui.panel} ${ui.panelCompact} ${s.resourceCard}`}>
              <span className={s.metricLabel}>Задержка {k} · 24 ч</span>
              <span className={s.metricValue}>{msFmt(v)}</span>
              <span className={s.hostMeta}>по {stats.latency.samples} успешным</span>
            </div>
          ))}
          <div className={`${ui.panel} ${ui.panelCompact} ${s.resourceCard}`}>
            <span className={s.metricLabel}>Ошибки · 24 ч</span>
            <span className={`${s.metricValue} ${failed ? s.critical : ''}`}>{failed}</span>
            <span className={s.hostMeta}>{stats.errors.slice(0, 2).map((e) => `${e.count} × ${e.error}`).join(' · ') || 'сбоев не было'}</span>
          </div>
        </div>

        <h3 className={ui.panelTitle}>
          Задержка успешных проверок · {byHour ? 'по часам' : 'последние проверки'}
          {failed ? <span className={s.critical}> · ┊ — сбои</span> : null}
        </h3>
        <TimeSeriesChart
          points={latency}
          label={`Задержка ${m.name}`}
          format={(v) => msFmt(Math.round(v))}
          markers={stats.failures.map((f) => ({ t: f.t, label: `${dateTime(f.t)} — ${f.error}` }))}
          emptyText="Нужно минимум две успешные проверки"
        />

        {stats.errors.length ? (
          <>
            <h3 className={ui.panelTitle}>Ошибки по причинам · 24 ч</h3>
            <ul className={s.factList}>
              {stats.errors.map((e) => (
                <li key={e.error} className={s.factBad}>
                  <b>{e.count}</b> × {e.error} <span className={ui.faint}>· последняя {timeAgo(e.lastAt)}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {http || m.type === 'tcp' ? (
          <>
            <h3 className={ui.panelTitle}>Фазы запроса · средние за 24 ч</h3>
            <PhaseBar phases={stats.phases} />
          </>
        ) : null}

        <h3 className={ui.panelTitle}>Последние проверки</h3>
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Время</th>
                <th>Результат</th>
                {http ? <th>Код</th> : null}
                {http || m.type === 'tcp' ? (
                  <>
                    <th>DNS</th>
                    <th>Соединение</th>
                  </>
                ) : null}
                {http ? (
                  <>
                    <th>TLS</th>
                    <th>TTFB</th>
                  </>
                ) : null}
                <th>Всего</th>
                <th>Ошибка</th>
              </tr>
            </thead>
            <tbody>
              {recent.slice(0, 15).map((r) => (
                <tr key={r.id}>
                  <td className={ui.num}>{fullDateTime(r.createdAt)}</td>
                  <td>
                    <StatusBadge status={r.ok ? 'healthy' : 'critical'} label={r.ok ? 'OK' : 'Сбой'} />
                  </td>
                  {http ? <td className={ui.num}>{r.statusCode ?? '—'}</td> : null}
                  {http || m.type === 'tcp' ? (
                    <>
                      <td className={ui.num}>{msFmt(r.dnsMs)}</td>
                      <td className={ui.num}>{msFmt(r.connectMs)}</td>
                    </>
                  ) : null}
                  {http ? (
                    <>
                      <td className={ui.num}>{msFmt(r.tlsMs)}</td>
                      <td className={ui.num}>{msFmt(r.ttfbMs)}</td>
                    </>
                  ) : null}
                  <td className={ui.num}>{msFmt(r.latencyMs)}</td>
                  <td className={ui.small}>{r.error ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <MaintenanceDialog scope="monitor" target={String(m.id)} name={m.name} open={maint} onClose={() => setMaint(false)} />
    </Panel>
  )
}
